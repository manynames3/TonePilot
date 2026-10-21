import Foundation
import AppKit
import Combine

struct SelectedPhoto: Identifiable, Hashable {
    let id: String
    let filename: String
}

struct SessionRecord: Identifiable {
    let url: URL
    let date: Date
    var id: String { url.path }
    var title: String {
        if url.lastPathComponent == "report.md" {
            return url.deletingLastPathComponent().lastPathComponent.replacingOccurrences(of: "session-", with: "Session ")
        }
        return url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "edit-", with: "Session ")
    }
}

final class WorkspaceModel: ObservableObject {
    @Published var lightroomInstalled = false
    @Published var lightroomOpen = false
    @Published var bridgeInstalled = false
    @Published var bridgeReady = false
    @Published var codexReady = false
    @Published var photos: [SelectedPhoto] = []
    @Published var screen: Screen = .workspace
    @Published var panel: Panel?
    @Published var busy = false
    @Published var phase = "Ready to start"
    @Published var events: [String] = []
    @Published var report = ""
    @Published var reportURL: URL?
    @Published var sessions: [SessionRecord] = []
    @Published var alertMessage: String?
    @Published var scanComplete = false
    @Published var pendingPlanURL: URL?
    @Published var planSummary = ""
    @Published var proposedCount = 0
    @Published var restoreSessionURL: URL?
    @Published var engineStage = ""
    @Published var confirmApply = false
    @Published var confirmRestore = false

    private var runningProcess: Process?
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TonePilot")
    var runs: URL { root.appendingPathComponent("runs") }
    private var engineURL: URL {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("TonePilotEngine/engine.mjs"),
           FileManager.default.fileExists(atPath: bundled.path) { return bundled }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/Lightroom-AI-FirstPass/TonePilot/Engine/engine.mjs")
    }
    private var scannerURL: URL {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("scan-selection.mjs"),
           FileManager.default.fileExists(atPath: bundled.path) { return bundled }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/Lightroom-AI-FirstPass/TonePilot/scan-selection.mjs")
    }
    private var nodePath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let paths = [home + "/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? paths[0]
    }
    private var codexPath: String {
        let candidates = [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/codex").path,
            "/opt/homebrew/bin/codex", "/usr/local/bin/codex"
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? candidates[0]
    }

    init() {
        try? FileManager.default.createDirectory(at: runs, withIntermediateDirectories: true)
        refresh()
        refreshSessions()
    }

    func refresh() {
        let base = FileManager.default.homeDirectoryForCurrentUser.path
        lightroomInstalled = FileManager.default.fileExists(atPath: "/Applications/Adobe Lightroom Classic/Adobe Lightroom Classic.app")
        bridgeInstalled = FileManager.default.fileExists(atPath: base + "/Library/Application Support/Adobe/Lightroom/Modules/LightroomMCP.lrplugin/Info.lua")
        codexReady = FileManager.default.isExecutableFile(atPath: codexPath)
        lightroomOpen = NSWorkspace.shared.runningApplications.contains {
            ($0.bundleIdentifier == "com.adobe.LightroomClassicCC7") ||
            ($0.localizedName?.contains("Lightroom Classic") ?? false)
        }
        DispatchQueue.global(qos: .utility).async {
            let listening = Self.readCommand("/usr/sbin/lsof", ["-nP", "-iTCP:58763", "-sTCP:LISTEN"]).contains("58763")
            DispatchQueue.main.async { self.bridgeReady = self.lightroomOpen && listening }
        }
    }

    func openLightroom() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Adobe Lightroom Classic/Adobe Lightroom Classic.app"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.refresh() }
    }

    func openProject() { NSWorkspace.shared.open(root) }
    func openReport() { if let reportURL { NSWorkspace.shared.open(reportURL) } }

    func refreshSessions() {
        let files = ((try? FileManager.default.contentsOfDirectory(at: runs, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("edit-") && $0.pathExtension == "md" }
        let sessionDirs = ((try? FileManager.default.contentsOfDirectory(at: runs, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("session-") }
        let sessionReports = sessionDirs.map { $0.appendingPathComponent("report.md") }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        sessions = (files + sessionReports).map {
            SessionRecord(url: $0, date: (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }.sorted { $0.date > $1.date }
    }

    func selectReport(_ item: SessionRecord) {
        report = (try? String(contentsOf: item.url, encoding: .utf8)) ?? ""
        reportURL = item.url
        phase = "Review previous edits"
    }

    func scanSelection() {
        guard !busy else { return }
        refresh()
        guard codexReady, bridgeInstalled, lightroomOpen else {
            alertMessage = "Open Lightroom Classic and make sure the Lightroom MCP plug-in is installed. Codex must also be available."
            return
        }
        begin("Reading selection")
        scanComplete = false
        photos = []
        pendingPlanURL = nil
        proposedCount = 0
        planSummary = ""
        launchScanner { text, code in
            let jsonLine = text.split(separator: "\n").reversed()
                .first(where: { $0.first == "{" && $0.last == "}" })
            guard let jsonLine else {
                self.fail("Lightroom did not return a selection. Confirm Lightroom MCP is running in Plug-in Manager.")
                return
            }
            let normalized = String(jsonLine)
            guard let data = normalized.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                self.fail("Could not read the Lightroom selection. See Activity for details.")
                return
            }
            if let error = object["error"] as? String { self.fail(error); return }
            let rows = object["photos"] as? [[String: Any]] ?? []
            let count = (object["count"] as? Int) ?? rows.count
            self.photos = rows.compactMap { item in
                guard let rawID = item["id"] else { return nil }
                let id = String(describing: rawID)
                guard !id.isEmpty else { return nil }
                return SelectedPhoto(id: id, filename: (item["filename"] as? String) ?? "Photo \(id)")
            }
            self.scanComplete = true
            self.busy = false
            if count > 0 && count <= 20 && self.photos.count != count {
                self.scanComplete = false
                self.phase = "Selection incomplete"
                self.alertMessage = "Lightroom reported \(count) selected photos, but only \(self.photos.count) valid IDs were read. Please scan again."
            } else if count == 0 {
                self.phase = "No photos selected"
                self.alertMessage = "Select 10–20 photos in Lightroom's filmstrip, then try Scan Selection."
            } else if count > 20 {
                self.phase = "Selection too large"
                self.alertMessage = "Lightroom returned \(count) selected photos. Choose 20 or fewer for the pilot."
            } else {
                self.phase = "\(self.photos.count) photos ready for editing"
                self.note("Selection verified: \(self.photos.count) of \(count) photos")
            }
        }
    }

    // The first action only ANALYZES. No Lightroom Develop writes occur until
    // the photographer separately confirms and applies a validated plan.
    func startFirstPass(style: String, strength: String, wb: Bool, exposure: Bool, tone: Bool) {
        guard !busy, scanComplete, (1...20).contains(photos.count) else { return }
        guard wb || exposure || tone else { alertMessage = "Enable at least one correction."; return }
        let ids = photos.map(\.id)
        guard Set(ids).count == ids.count else { alertMessage = "Duplicate selected IDs; read selection again."; return }
        pendingPlanURL = nil
        restoreSessionURL = nil
        planSummary = ""
        proposedCount = 0
        runEngine(stage: "analyze", arguments: [
            "--ids", String(data: (try! JSONSerialization.data(withJSONObject: ids)), encoding: .utf8)!,
            "--look", style, "--strength", strength,
            "--wb", wb ? "true" : "false", "--exposure", exposure ? "true" : "false",
            "--tone", tone ? "true" : "false"
        ])
    }

    func discardPendingPlan() {
        guard !busy else { return }
        pendingPlanURL = nil
        proposedCount = 0
        planSummary = ""
        phase = "Plan discarded — settings can be changed"
    }

    func applyReviewedPlan() {
        guard !busy, let plan = pendingPlanURL else { return }
        pendingPlanURL = nil
        planSummary = ""
        runEngine(stage: "apply", arguments: ["--session", plan.path, "--confirm"])
    }

    func restoreLastSession() {
        guard !busy, let session = restoreSessionURL else { return }
        runEngine(stage: "restore", arguments: ["--session", session.path, "--confirm"])
    }

    private func runEngine(stage: String, arguments: [String]) {
        begin(stage == "analyze" ? "Reading baselines and analyzing previews" :
              stage == "apply" ? "Applying approved adjustments" : "Restoring original settings")
        engineStage = stage
        let root = self.root
        let helper = engineURL
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let node = nodePath
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: node)
            task.arguments = [helper.path, "--mode", stage] + arguments
            task.currentDirectoryURL = root
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = home + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            env["TONEPILOT_PROJECT_DIR"] = root.path
            env["TONEPILOT_RUNS_DIR"] = self.runs.path
            env["TONEPILOT_CODEX"] = self.codexPath
            if let metrics = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("TonePilotMetrics") {
                env["TONEPILOT_METRICS_BIN"] = metrics.path
            }
            task.environment = env
            task.standardInput = FileHandle.nullDevice
            let output = Pipe()
            task.standardOutput = output
            task.standardError = output
            let lock = NSLock()
            var completeOutput = ""
            output.fileHandleForReading.readabilityHandler = { handle in
                let next = handle.availableData
                if next.isEmpty { handle.readabilityHandler = nil; return }
                let chunk = String(decoding: next, as: UTF8.self)
                lock.lock()
                completeOutput += chunk
                lock.unlock()
                for line in chunk.split(separator: "\n") {
                    guard let data = String(line).data(using: .utf8),
                          let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                          let kind = event["type"] as? String else { continue }
                    let message = (event["phase"] as? String) ?? (event["message"] as? String) ?? kind
                    DispatchQueue.main.async {
                        if kind == "progress" {
                            self.phase = message
                            self.note(message + ((event["filename"] as? String).map { " — " + $0 } ?? ""))
                        }
                    }
                }
            }
            task.terminationHandler = { process in
                output.fileHandleForReading.readabilityHandler = nil
                // Node owns its subprocess pipes, so unlike Codex MCP child output
                // this stream terminates when the engine itself exits.
                let tail = output.fileHandleForReading.readDataToEndOfFile()
                lock.lock()
                completeOutput += String(decoding: tail, as: UTF8.self)
                let all = completeOutput
                lock.unlock()
                let events: [[String: Any]] = all.split(separator: "\n").compactMap { line in
                    guard let data = String(line).data(using: .utf8) else { return nil }
                    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                }
                let saved = events.last(where: { $0["type"] as? String == "session" })?["path"] as? String
                let last = events.last(where: { $0["type"] as? String == "complete" })
                let error = events.last(where: { $0["type"] as? String == "error" })?["message"] as? String
                let sessionPath = (last?["path"] as? String) ?? saved
                DispatchQueue.main.async {
                    self.runningProcess = nil
                    self.busy = false
                    self.refreshSessions()
                    if let sessionPath {
                        let dir = URL(fileURLWithPath: sessionPath)
                        let reportURL = dir.appendingPathComponent("report.md")
                        self.reportURL = reportURL
                        self.report = (try? String(contentsOf: reportURL, encoding: .utf8)) ?? ""
                    }
                    if process.terminationStatus == 0, let state = last?["state"] as? String {
                        switch state {
                        case "planned":
                            if let sessionPath { self.pendingPlanURL = URL(fileURLWithPath: sessionPath) }
                            let proposed = last?["proposed"] as? Int ?? 0
                            let flagged = last?["flagged"] as? Int ?? 0
                            self.proposedCount = proposed
                            self.planSummary = "\(proposed) photos with proposed edits · \(flagged) flagged"
                            self.phase = "Plan ready — review before applying"
                        case "applied":
                            if let sessionPath { self.restoreSessionURL = URL(fileURLWithPath: sessionPath) }
                            self.phase = "Develop values verified — review in Lightroom"
                        case "restored":
                            self.restoreSessionURL = nil
                            self.phase = "Original Develop settings restored"
                        default: self.phase = "Session finished"
                        }
                        self.note(self.phase)
                    } else {
                        self.phase = "Editing operation failed — review session report"
                        self.note(error ?? "Engine failed with exit code \(process.terminationStatus)")
                        self.alertMessage = error ?? "TonePilot encountered an error. Review the session report and Lightroom Develop history."
                    }
                    self.refresh()
                }
            }
            DispatchQueue.main.async { self.runningProcess = task }
            do { try task.run() }
            catch {
                output.fileHandleForReading.readabilityHandler = nil
                DispatchQueue.main.async {
                    self.runningProcess = nil
                    self.fail("Unable to start the guarded engine: \(error.localizedDescription)")
                }
            }
        }
    }

    func stop() {
        guard busy, let runningProcess else { return }
        runningProcess.terminate()
        note("Stop requested. Verify any already-applied edits in Lightroom.")
        phase = "Stopping…"
    }

    private func begin(_ title: String) {
        events = []; busy = true; phase = title
        report = ""; reportURL = nil
        note(title)
    }

    private func fail(_ message: String) {
        busy = false; phase = "Action required"; alertMessage = message; note(message)
    }

    private func note(_ line: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)
        events.append("\(time)  \(line)")
        if events.count > 150 { events.removeFirst(events.count - 150) }
    }

    private func launchScanner(completion: @escaping (String, Int32) -> Void) {
        let helper = scannerURL
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let node = nodePath
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: node)
            task.arguments = [helper.path]
            task.currentDirectoryURL = self.root
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = home + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            task.environment = env
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = pipe
            DispatchQueue.main.async { self.runningProcess = task }
            do { try task.run() }
            catch {
                DispatchQueue.main.async {
                    self.runningProcess = nil
                    self.fail("Could not start Lightroom scanner: \(error.localizedDescription)")
                }
                return
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            let output = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                self.runningProcess = nil
                completion(output, task.terminationStatus)
                self.refresh()
            }
        }
    }

    private func launchCodex(prompt: String, finalFile: URL, editing: Bool, completion: @escaping (String, Int32) -> Void) {
        let root = self.root
        let executable = codexPath
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.currentDirectoryURL = root
            // In a background macOS app there is no terminal to approve MCP actions.
            // Let Codex's automatic reviewer evaluate requests; never bypass its sandbox.
            p.arguments = [
                "exec", "--json", "--approve-for-me", "--skip-git-repo-check",
                "-C", root.path, "--sandbox", "workspace-write",
                "--output-last-message", finalFile.path, prompt
            ]
            var env = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            env["PATH"] = home + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            p.environment = env
            p.standardInput = FileHandle.nullDevice
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            let readerQueue = DispatchQueue(label: "app.tonepilot.codexoutput")
            var pending = ""
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else {
                    handle.readabilityHandler = nil
                    return
                }
                readerQueue.async {
                    pending += String(decoding: data, as: UTF8.self)
                    while let newline = pending.firstIndex(of: "\n") {
                        let line = String(pending[..<newline])
                        pending.removeSubrange(...newline)
                        if let summary = Self.summarizeEvent(line) {
                            DispatchQueue.main.async { self.note(summary) }
                        }
                    }
                }
            }
            // IMPORTANT: process termination, not output-pipe EOF, finishes the UI session.
            // MCP subprocesses may inherit stdout and keep the pipe open indefinitely.
            p.terminationHandler = { process in
                pipe.fileHandleForReading.readabilityHandler = nil
                let result = (try? String(contentsOf: finalFile, encoding: .utf8)) ?? ""
                DispatchQueue.main.async {
                    self.runningProcess = nil
                    completion(result, process.terminationStatus)
                    self.refresh()
                }
            }
            DispatchQueue.main.async { self.runningProcess = p }
            do { try p.run() }
            catch {
                pipe.fileHandleForReading.readabilityHandler = nil
                DispatchQueue.main.async {
                    self.runningProcess = nil
                    self.fail("Could not start Codex: \(error.localizedDescription)")
                }
            }
        }
    }

    private static func summarizeEvent(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            if line.lowercased().contains("error") { return String(line.prefix(220)) }
            return nil
        }
        let type = (value["type"] as? String) ?? ""
        if type == "turn.failed" { return "AI session reported an error" }
        if type == "turn.completed" { return "AI reasoning finished" }
        if type == "item.started" || type == "item.completed" {
            guard let item = value["item"] as? [String: Any] else { return nil }
            let kind = (item["type"] as? String) ?? ""
            if kind == "mcp_tool_call" {
                let tool = (item["tool"] as? String) ?? "Lightroom tool"
                return (type == "item.started" ? "Working: " : "Finished: ") + tool
            }
            if kind == "agent_message" && type == "item.completed" {
                let message = (item["text"] as? String) ?? ""
                if !message.isEmpty { return String(message.replacingOccurrences(of: "\n", with: " ").prefix(150)) }
            }
            if kind == "command_execution" && type == "item.started" { return "Preparing session records…" }
        }
        return nil
    }

    private static func stamp() -> String {
        let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return formatter.string(from: Date())
    }

    private static func readCommand(_ path: String, _ args: [String]) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path); proc.arguments = args
        let pipe = Pipe(); proc.standardOutput = pipe; proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            return String(data: data, encoding: .utf8) ?? ""
        } catch { return "" }
    }
}
