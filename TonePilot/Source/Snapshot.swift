import AppKit
import SwiftUI

// Developer tool for visual review without Screen Recording permission: with
// TONEPILOT_SNAPSHOT_DIR set, the app renders its own window to PNG for each screen
// (setup, new pass, every session) and quits. Never active in normal use.
@MainActor
enum Snapshot {
    static var directory: URL? { ProcessInfo.processInfo.environment["TONEPILOT_SNAPSHOT_DIR"].map { URL(fileURLWithPath: $0) } }

    static func runIfRequested(_ model: AppModel) async {
        guard let dir = directory else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let appearance = ProcessInfo.processInfo.environment["TONEPILOT_SNAPSHOT_APPEARANCE"] ?? "light"
        NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
        try? await Task.sleep(for: .seconds(2))
        guard let window = NSApp.windows.first(where: { $0.canBecomeKey }) else { return }
        window.setFrame(NSRect(x: 80, y: 80, width: 1180, height: 800), display: true)
        model.route = .setup
        await capture(window, dir, "1-setup-\(appearance)")
        model.route = .newPass
        if model.selection == nil { await model.readSelection() }
        await capture(window, dir, "2-new-pass-\(appearance)")
        for (i, s) in model.sessions.prefix(3).enumerated() {
            await model.open(s.id)
            await capture(window, dir, "3-session-\(i + 1)-\(appearance)")
        }
        NSApp.terminate(nil)
    }

    private static func capture(_ window: NSWindow, _ dir: URL, _ name: String) async {
        try? await Task.sleep(for: .seconds(Double(ProcessInfo.processInfo.environment["TONEPILOT_SNAPSHOT_DELAY"] ?? "") ?? 1.5))
        guard let view = window.contentView?.superview ?? window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name + ".png"))
    }
}
