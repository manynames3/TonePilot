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
    var title: String { url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "edit-", with: "Session ") }
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

    private var runningProcess: Process?
    let root = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Documents/Lightroom-AI-FirstPass")
    var runs: URL { root.appendingPathComponent("runs") }
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
        sessions = files.map {
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

    func startFirstPass(style: String, strength: String, wb: Bool, exposure: Bool, tone: Bool) {
        guard !busy, scanComplete, !photos.isEmpty, photos.count <= 20 else { return }
        guard wb || exposure || tone else { alertMessage = "Enable at least one correction."; return }
        let ids = photos.map(\.id)
        guard Set(ids).count == ids.count else {
            alertMessage = "The selected IDs are not unique. Scan again before editing."
            return
        }
        begin("Editing selected photos")
        let finalFile = runs.appendingPathComponent("edit-\(Self.stamp()).md")
        let targets: [String] = [
            wb ? "White balance and Tint (natural skin, accurate neutrality)" : "",
            exposure ? "Subject exposure, respecting highlight detail" : "",
            tone ? "Highlights, shadows, white point, black point (subtle realistic contrast)" : ""
        ].filter { !$0.isEmpty }
        let strengthDescription = strength == "Subtle" ? "VERY conservative changes, high confidence only." :
            strength == "Balanced" ? "Conservative professional corrections." :
            "Slightly stronger fixes when strongly justified, avoid stylization."
        let styleDescription = style == "Soft & airy" ? "Bright airy portraits, natural contrast and real skin." :
            style == "True to scene" ? "Keep genuine scene mood and intentional warmth/coolness." :
            "Clean natural portrait photography, realistic skin and balanced contrast."
        let prompt = """
        Run the AI FIRST-PASS EDIT workflow in AGENTS.md.
        STRICT BOUNDARY: The scan authorized exactly \(ids.count) Lightroom IDs: \(ids.joined(separator: ", ")).
        First call get_selected_photos. Do not edit unless its entire selected ID set matches exactly the
        authorized ID set and total count is exactly \(ids.count). If mismatch STOP with NO edits.
        Before the FIRST edit, read Develop settings for every selected photo and save a baseline JSON
        in the project's runs directory. If the baseline cannot be written, STOP without editing.
        If the Lightroom tool supports snapshots, create a labeled pre-edit Develop snapshot per photo.
        Do not edit other photos. Do not alter crop, camera profile, masks, metadata, or ratings.
        Correction areas enabled ONLY: \(targets.joined(separator: "; ")).
        Never change a correction area that was not enabled.
        STYLE: \(styleDescription)
        INTENSITY: \(strengthDescription)
        Review actual previews and re-render edited images for before/after verification.
        Look carefully at magenta/green skin tint, exposure consistency by scene, and intentional light.
        Flag difficult mixed-light images for human review; skip if confidence is low.
        Write a Markdown report to \(finalFile.path) and ALSO include the full report in your final answer.
        Report sections: Overview (edited/skipped/flagged); Needs My Review (filenames & reasons);
        Photo Adjustments (filename, original/new settings, rationale); Overall Consistency.
        No export, publish, move, delete or upload operations.
        """
        launchCodex(prompt: prompt, finalFile: finalFile, editing: true) { text, code in
            self.busy = false
            self.refreshSessions()
            self.reportURL = finalFile
            let fromDisk = (try? String(contentsOf: finalFile, encoding: .utf8)) ?? ""
            self.report = !fromDisk.isEmpty ? fromDisk : text
            let normalized = self.report.lowercased()
            let documentedBlocker =
                normalized.contains("stopped before editing") ||
                normalized.contains("mcp tool call requires approval") ||
                normalized.contains("first-pass edit remains incomplete") ||
                normalized.contains("no develop settings or previews were retrieved")
            if documentedBlocker {
                self.phase = "First pass blocked — no edits confirmed"
                self.note("AI reported a blocked run. Open Reports for the explanation.")
                self.alertMessage = "The AI could not finish editing. Open Reports for details and check Lightroom Develop History before retrying."
            } else if code == 0 && !self.report.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                self.phase = "AI session finished — review Lightroom"
                self.note("AI session finished. Verify the actual photo adjustments in Lightroom.")
            } else {
                self.phase = "AI session failed — inspect Lightroom"
                self.note("The session ended early; some edits may have been applied.")
                self.alertMessage = "The session did not complete. Check Lightroom Develop History before retrying."
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
        let helper = root.appendingPathComponent("TonePilot/scan-selection.mjs")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let node = home + "/.local/bin/node"
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
