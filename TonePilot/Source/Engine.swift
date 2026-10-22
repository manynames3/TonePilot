import Foundation

// Locations and the child-process bridge to the guarded engine (Node.js).
enum Paths {
    static let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TonePilot", isDirectory: true)
    // TONEPILOT_RUNS_DIR lets developers point the app at a scratch folder.
    static let runs = ProcessInfo.processInfo.environment["TONEPILOT_RUNS_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? support.appendingPathComponent("runs", isDirectory: true)
    static let pluginFolder = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Adobe/Lightroom/Modules", isDirectory: true)

    // Developers can point at a source checkout with TONEPILOT_ENGINE_DIR; releases use the bundle.
    static var engine: URL? {
        if let dev = ProcessInfo.processInfo.environment["TONEPILOT_ENGINE_DIR"] {
            return URL(fileURLWithPath: dev).appendingPathComponent("engine.mjs")
        }
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("TonePilotEngine/engine.mjs")
        return bundled.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
    }
    static var analyzer: URL? {
        let url = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("TonePilotAnalyzer")
        return url.flatMap { FileManager.default.isExecutableFile(atPath: $0.path) ? $0 : nil }
    }
    static var bundledBridge: URL? {
        let url = Bundle.main.resourceURL?.appendingPathComponent("BridgeServer/node_modules/@mskalski/lightroom-mcp/dist/index.js")
        return url.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
    }
    private static func firstExecutable(_ candidates: [String]) -> String? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    static var node: String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return firstExecutable([UserDefaults.standard.string(forKey: "nodePath") ?? "",
                                "/opt/homebrew/bin/node", "/usr/local/bin/node", home + "/.local/bin/node", home + "/.volta/bin/node"])
    }
    static var codex: String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return firstExecutable([UserDefaults.standard.string(forKey: "codexPath") ?? "",
                                home + "/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"])
    }
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev" }
}

struct EngineResult {
    let status: Int32
    let complete: Data?        // the final {"type":"complete",...} line
    let error: String?
    let warnings: [String]
    var ok: Bool { status == 0 && complete != nil }
}

enum EngineFailure: LocalizedError {
    case missing(String)
    var errorDescription: String? { if case .missing(let what) = self { return what }; return nil }
}

final class EngineRunner {
    private var process: Process?

    var isRunning: Bool { process?.isRunning ?? false }

    // Requests a safe stop: the engine finishes the photo it is writing, then halts.
    func stop() { process?.terminate() }

    func run(_ arguments: [String], onEvent: @escaping (EngineEvent) -> Void) async throws -> EngineResult {
        guard let node = Paths.node else { throw EngineFailure.missing("Node.js was not found. Install Node.js 18 or newer.") }
        guard let engine = Paths.engine else { throw EngineFailure.missing("The TonePilot engine is missing from the app bundle. Reinstall TonePilot.") }
        try? FileManager.default.createDirectory(at: Paths.runs, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [engine.path] + arguments
        task.currentDirectoryURL = Paths.support
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = home + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["TONEPILOT_PROJECT_DIR"] = Paths.support.path
        env["TONEPILOT_RUNS_DIR"] = Paths.runs.path
        env["TONEPILOT_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env["TONEPILOT_VERSION"] = Paths.version
        env["TONEPILOT_NODE"] = node
        if let codex = Paths.codex { env["TONEPILOT_CODEX"] = codex }
        if let analyzer = Paths.analyzer { env["TONEPILOT_ANALYZER"] = analyzer.path }
        if let bridge = Paths.bundledBridge { env["TONEPILOT_MCP_SERVER"] = bridge.path }
        task.environment = env
        task.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        task.standardOutput = out
        task.standardError = err

        let collector = LineCollector(onEvent: onEvent)
        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { collector.feed(data) }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }   // drained, never shown: may contain paths
        }
        return try await withCheckedThrowingContinuation { continuation in
            task.terminationHandler = { finished in
                out.fileHandleForReading.readabilityHandler = nil
                collector.feed(out.fileHandleForReading.readDataToEndOfFile())
                collector.flush()
                continuation.resume(returning: EngineResult(status: finished.terminationStatus, complete: collector.complete,
                                                            error: collector.error, warnings: collector.warnings))
            }
            do { try task.run(); self.process = task }
            catch { continuation.resume(throwing: error) }
        }
    }
}

// Splits stdout into JSON lines; progress goes to the UI, the final result is kept.
private final class LineCollector {
    private let lock = NSLock()
    private var buffer = Data()
    private(set) var complete: Data?
    private(set) var error: String?
    private(set) var warnings: [String] = []
    private let onEvent: (EngineEvent) -> Void
    init(onEvent: @escaping (EngineEvent) -> Void) { self.onEvent = onEvent }

    func feed(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            handle(line)
        }
    }
    func flush() { lock.lock(); defer { lock.unlock() }; if !buffer.isEmpty { handle(buffer); buffer.removeAll() } }

    private func handle(_ line: Data) {
        guard let event = try? JSONDecoder().decode(EngineEvent.self, from: line) else { return }
        switch event.type {
        case "complete": complete = line
        case "error": error = event.message
        case "warning": if let m = event.message { warnings.append(m) }
        default: break
        }
        DispatchQueue.main.async { self.onEvent(event) }
    }
}
