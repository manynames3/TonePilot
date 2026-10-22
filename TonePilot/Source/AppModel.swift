import Foundation
import AppKit
import SwiftUI

enum Route: Hashable { case setup, newPass, session(String) }

struct Operation: Equatable {
    enum Kind: String { case doctor, inspect, analyze, apply, restore, reconcile, discard }
    let kind: Kind
    var title: String
    var detail: String = ""
    var index: Int? = nil
    var total: Int? = nil
    var stopping = false
    var sessionID: String? = nil
    var fraction: Double? { guard let index, let total, total > 0 else { return nil }; return Double(index) / Double(total) }
}

struct Notice: Identifiable { let id = UUID(); let title: String; let message: String }

@MainActor
final class AppModel: ObservableObject {
    @Published var doctor: DoctorReport?
    @Published var selection: SelectionReport?
    @Published var selectionError: String?
    @Published var sessions: [SessionSummary] = []
    @Published var runningElsewhere: RunningEngine?
    @Published var route: Route = .newPass
    @Published var session: SessionView?
    @Published var sessionError: String?
    @Published var operation: Operation?
    @Published var notice: Notice?
    @Published var approvals: [String: Set<String>] = [:]

    private static let defaults = UserDefaults.standard
    @Published var look = defaults.string(forKey: "look") ?? "Natural" { didSet { Self.defaults.set(look, forKey: "look") } }
    @Published var strength = defaults.string(forKey: "strength") ?? "Balanced" { didSet { Self.defaults.set(strength, forKey: "strength") } }
    @Published var fixWhiteBalance = defaults.object(forKey: "fixWhiteBalance") as? Bool ?? true { didSet { Self.defaults.set(fixWhiteBalance, forKey: "fixWhiteBalance") } }
    @Published var fixExposure = defaults.object(forKey: "fixExposure") as? Bool ?? true { didSet { Self.defaults.set(fixExposure, forKey: "fixExposure") } }
    @Published var fixTone = defaults.object(forKey: "fixTone") as? Bool ?? true { didSet { Self.defaults.set(fixTone, forKey: "fixTone") } }

    // Long operations own `runner` (Stop terminates it). Read-only queries use a fresh
    // runner each time so browsing sessions can never redirect Stop to the wrong process.
    private let runner = EngineRunner()
    private var launched = false

    var busy: Bool { operation != nil }
    var ready: Bool { doctor?.ready ?? false }
    var attentionSessions: [SessionSummary] { sessions.filter { $0.attention == true } }

    func launch() async {
        guard !launched else { return }
        launched = true
        await loadSessions()
        // After a crash or force quit, take the photographer straight to the session that needs checking.
        if let interrupted = sessions.first(where: { $0.status == "interrupted" }) { await open(interrupted.id) }
        await checkSetup()
        if !ready, case .newPass = route { route = .setup }
    }

    // MARK: Read-only

    func checkSetup(live: Bool = true) async {
        guard let data = await perform(.init(kind: .doctor, title: "Checking Lightroom, plug-in and AI service"),
                                       ["--mode", "doctor"] + (live ? ["--live"] : [])) else { return }
        doctor = try? JSONDecoder().decode(DoctorReport.self, from: data)
    }

    func readSelection() async {
        selectionError = nil
        guard let data = await perform(.init(kind: .inspect, title: "Reading your Lightroom selection"), ["--mode", "inspect"],
                                       quiet: true) else { return }
        do { selection = try JSONDecoder().decode(SelectionReport.self, from: data) }
        catch { selectionError = "Lightroom returned a selection TonePilot could not read." }
    }

    func loadSessions() async {
        guard let result = try? await EngineRunner().run(["--mode", "sessions"], onEvent: { _ in }),
              let data = result.complete,
              let report = try? JSONDecoder().decode(SessionsReport.self, from: data) else { return }
        sessions = report.sessions
        runningElsewhere = report.running
    }

    func open(_ id: String) async {
        route = .session(id)
        await reloadSession(id)
    }

    func reloadSession(_ id: String) async {
        sessionError = nil
        guard let summary = sessions.first(where: { $0.id == id }), !summary.isLegacy else { return }
        let result = try? await EngineRunner().run(["--mode", "show", "--session", summary.dir], onEvent: { _ in })
        guard let data = result?.complete, let wrapper = try? JSONDecoder().decode(ShowWrapper.self, from: data) else {
            sessionError = result?.error ?? "This session record could not be read."
            return
        }
        session = wrapper.session
        if approvals[id] == nil { approvals[id] = Set(wrapper.session.photos.filter { $0.state == "proposed" }.map(\.id)) }
    }
    private struct ShowWrapper: Decodable { let session: SessionView }

    // MARK: Engine operations

    func analyze() async {
        guard let selection, !selection.photos.isEmpty, !selection.overLimit else { return }
        let ids = selection.photos.map(\.id)
        let idJSON = String(data: try! JSONSerialization.data(withJSONObject: ids), encoding: .utf8)!
        guard let data = await perform(.init(kind: .analyze, title: "Analyzing \(ids.count) photos"),
            ["--mode", "analyze", "--ids", idJSON, "--look", look, "--strength", strength,
             "--wb", String(fixWhiteBalance), "--exposure", String(fixExposure), "--tone", String(fixTone)]) else { await loadSessions(); return }
        await finish(data)
    }

    func resumeAnalysis(_ s: SessionView) async {
        guard let data = await perform(.init(kind: .analyze, title: "Resuming analysis", sessionID: s.id),
                                       ["--mode", "analyze", "--resume", s.dir]) else { await refresh(s.id); return }
        await finish(data)
    }

    func apply(_ s: SessionView) async {
        let approved = s.photos.filter { $0.isApplicable && (approvals[s.id] ?? []).contains($0.id) }.map(\.id)
        guard !approved.isEmpty else { return }
        let only = String(data: try! JSONSerialization.data(withJSONObject: approved), encoding: .utf8)!
        _ = await perform(.init(kind: .apply, title: "Applying \(approved.count) approved edits", sessionID: s.id),
                          ["--mode", "apply", "--session", s.dir, "--confirm", "--only", only])
        await refresh(s.id)
    }

    func restore(_ s: SessionView) async {
        _ = await perform(.init(kind: .restore, title: "Restoring original settings", sessionID: s.id),
                          ["--mode", "restore", "--session", s.dir, "--confirm"])
        await refresh(s.id)
    }

    func reconcile(_ s: SessionView) async {
        _ = await perform(.init(kind: .reconcile, title: "Checking Lightroom for unconfirmed changes", sessionID: s.id),
                          ["--mode", "reconcile", "--session", s.dir])
        await refresh(s.id)
    }

    func discard(_ s: SessionView) async {
        _ = await perform(.init(kind: .discard, title: "Discarding plan", sessionID: s.id),
                          ["--mode", "discard", "--session", s.dir, "--confirm"])
        await loadSessions()
        route = .newPass; session = nil
    }

    func stop() {
        guard operation != nil else { return }
        operation?.stopping = true
        operation?.title = "Stopping after the current photo…"
        runner.stop()
    }

    func toggleApproval(_ photo: PhotoView, in s: SessionView) {
        var set = approvals[s.id] ?? []
        if set.contains(photo.id) { set.remove(photo.id) } else { set.insert(photo.id) }
        approvals[s.id] = set
    }
    func setAllApprovals(_ on: Bool, in s: SessionView) {
        approvals[s.id] = on ? Set(s.photos.filter(\.isApplicable).map(\.id)) : []
    }

    func copyFilenames(_ photos: [PhotoView]) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(photos.map(\.filename).joined(separator: ", "), forType: .string)
    }
    func openLightroom() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.adobe.LightroomClassicCC7") {
            NSWorkspace.shared.openApplication(at: url, configuration: .init())
        }
    }
    func revealPluginFolder() { NSWorkspace.shared.open(Paths.pluginFolder) }
    func revealSession(_ s: SessionView) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: s.dir).appendingPathComponent("report.txt")]) }

    // MARK: Plumbing

    private func finish(_ data: Data) async {
        await loadSessions()
        if let dir = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["dir"] as? String,
           let summary = sessions.first(where: { $0.dir == dir }) {
            await open(summary.id)
        }
    }

    private func refresh(_ id: String) async {
        await loadSessions()
        await reloadSession(id)
    }

    @discardableResult
    private func perform(_ op: Operation, _ args: [String], quiet: Bool = false) async -> Data? {
        guard operation == nil else { return nil }
        operation = op
        defer { operation = nil }
        do {
            let result = try await runner.run(args) { [weak self] event in
                guard let self, event.type == "progress", self.operation != nil, self.operation?.stopping == false else { return }
                self.operation?.detail = [event.phase, event.filename].compactMap { $0 }.joined(separator: " · ")
                self.operation?.index = event.index
                self.operation?.total = event.total
            }
            if let warning = result.warnings.first { notice = Notice(title: "Check before continuing", message: warning) }
            if result.ok {
                if let stopped = (try? JSONDecoder().decode(EngineEvent.self, from: result.complete!))?.stopped, op.kind != .analyze {
                    notice = Notice(title: "Stopped before finishing", message: stopped)
                }
                return result.complete
            }
            let message = result.error ?? "The TonePilot engine stopped unexpectedly (exit \(result.status))."
            if op.kind == .inspect { selectionError = message } else if !quiet { notice = Notice(title: failureTitle(op.kind), message: message) }
        } catch {
            let message = error.localizedDescription
            if op.kind == .inspect { selectionError = message } else { notice = Notice(title: failureTitle(op.kind), message: message) }
        }
        return nil
    }

    private func failureTitle(_ kind: Operation.Kind) -> String {
        switch kind {
        case .apply: return "Edits were not fully applied"
        case .restore: return "Restore did not finish"
        case .analyze: return "Analysis did not finish"
        case .reconcile: return "Could not check Lightroom"
        default: return "TonePilot could not continue"
        }
    }
}
