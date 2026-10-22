import SwiftUI
import AppKit

@main
struct TonePilotApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("TonePilot", id: "main") {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 980, minHeight: 640)
                .tint(Theme.accent)
                .task { await model.launch(); await Snapshot.runIfRequested(model) }
        }
        .defaultSize(width: 1180, height: 800)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New First Pass") { model.route = .newPass }.keyboardShortcut("n", modifiers: .command)
                Button("Read Lightroom Selection") { Task { await model.readSelection() } }
                    .keyboardShortcut("r", modifiers: .command).disabled(model.busy || !model.ready)
                Divider()
                Button("Check Setup") { model.route = .setup; Task { await model.checkSetup() } }
                Button("Stop After Current Photo") { model.stop() }.keyboardShortcut(".", modifiers: .command).disabled(!model.busy)
            }
        }
        MenuBarExtra("TonePilot", systemImage: "camera.aperture") {
            Button("Open TonePilot") {
                NSApp.activate(ignoringOtherApps: true)
                NSApp.windows.first(where: { $0.canBecomeKey })?.makeKeyAndOrderFront(nil)
            }
            Divider()
            if let op = model.operation { Text(op.title) } else { Text(model.ready ? "Ready" : "Setup needed") }
            if !model.attentionSessions.isEmpty { Text(Format.plural(model.attentionSessions.count, "session") + " need attention") }
            Divider()
            Button("Quit TonePilot") { NSApp.terminate(nil) }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            Sidebar().navigationSplitViewColumnWidth(min: 250, ideal: 280, max: 340)
        } detail: {
            detail
                .safeAreaInset(edge: .top, spacing: 0) { if let op = model.operation, op.kind != .doctor || model.doctor == nil { ProgressPanel(op: op) } }
        }
        .alert(item: $model.notice) { n in Alert(title: Text(n.title), message: Text(n.message), dismissButton: .default(Text("OK"))) }
        .onExitCommand { model.stop() }
    }

    @ViewBuilder private var detail: some View {
        switch model.route {
        case .setup: SetupView()
        case .newPass: NewPassView()
        case .session(let id):
            if let summary = model.sessions.first(where: { $0.id == id }), summary.isLegacy { LegacySessionView(summary: summary) }
            else if let s = model.session, s.id == id { SessionDetailView(session: s).id(s.id + (s.updatedAt ?? "")) }
            else if let error = model.sessionError {
                ScrollView {
                    Callout(tone: .danger, systemImage: "doc.badge.ellipsis", title: "Session unavailable", message: error)
                        .padding(28).frame(maxWidth: 700, alignment: .leading)
                }
            } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
    }
}

private struct Sidebar: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List(selection: Binding<Route?>(get: { model.route }, set: { r in
            guard let r else { return }
            if case .session(let id) = r { Task { await model.open(id) } } else { model.route = r }
        })) {
            Section {
                Label("New first pass", systemImage: "plus.circle").tag(Route.newPass)
                Label { HStack { Text("Setup"); Spacer(); if model.doctor != nil && !model.ready { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger) } } }
                    icon: { Image(systemName: "checklist") }.tag(Route.setup)
            }
            if !model.attentionSessions.isEmpty {
                Section("Needs attention") { ForEach(model.attentionSessions) { SessionRow(s: $0).tag(Route.session($0.id)) } }
            }
            Section("Sessions") {
                let others = model.sessions.filter { $0.attention != true && $0.status != "discarded" }
                if others.isEmpty && model.attentionSessions.isEmpty {
                    Text("Your sessions appear here.").font(Theme.secondary).foregroundStyle(.secondary)
                }
                ForEach(others) { SessionRow(s: $0).tag(Route.session($0.id)) }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) { connection }
    }

    private var connection: some View {
        let live = model.doctor?.checks.first { $0.id == "live-bridge" }
        return HStack(spacing: 8) {
            Circle().fill(live?.ok == true ? Theme.verified : model.doctor == nil ? Theme.neutral : Theme.danger).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(live?.ok == true ? "Lightroom connected" : model.doctor == nil ? "Not checked yet" : "Lightroom not connected").font(Theme.secondaryStrong)
                if let d = live?.detail { Text(d).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer()
            Button { Task { await model.checkSetup() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless).help("Check the Lightroom connection again").disabled(model.busy)
        }
        .padding(12)
    }
}

// Same structure as the other screens (scroll view, no flexible spacer): a bare VStack
// with a Spacer and fixed-size text here blanked the whole window on macOS 27.
private struct LegacySessionView: View {
    let summary: SessionSummary
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                StatusBadge(label: summary.label, tone: summary.attention == true ? .attention : .neutral)
                Text(Format.date(summary.created)).font(Theme.title)
                Text(summary.explanation ?? "").font(Theme.body).fixedSize(horizontal: false, vertical: true)
                Text("TonePilot 0.5 keeps a crash-safe journal for every session. Older sessions are listed for reference only and can't be applied or restored from here.")
                    .font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: summary.dir)]) }
            }
            .padding(28).frame(maxWidth: 760, alignment: .leading)
        }
    }
}

private struct SessionRow: View {
    let s: SessionSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(Format.date(s.created)).font(Theme.bodyStrong).monospacedDigit()
                Spacer()
                if s.running != nil { ProgressView().controlSize(.small) }
            }
            HStack(spacing: 6) {
                Circle().fill(sessionTone(s.status).color).frame(width: 7, height: 7)
                Text(s.label).font(Theme.secondary)
                Text("· " + Format.plural(s.photoCount ?? 0, "photo")).font(Theme.secondary).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct ProgressPanel: View {
    @EnvironmentObject var model: AppModel
    let op: Operation
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                if let f = op.fraction { ProgressView(value: f).frame(width: 140) } else { ProgressView().controlSize(.small) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(op.title).font(Theme.bodyStrong)
                    if !op.detail.isEmpty {
                        Text(op.detail + (op.index.map { i in op.total.map { " (\(i) of \($0))" } ?? "" } ?? ""))
                            .font(Theme.secondary).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                if [.analyze, .apply, .restore].contains(op.kind) {
                    Button(op.stopping ? "Stopping…" : "Stop") { model.stop() }
                        .disabled(op.stopping).help("Finishes the photo being written, then stops (Esc)")
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 10)
            Divider()
        }
        .background(.bar)
        .accessibilityElement(children: .combine)
    }
}
