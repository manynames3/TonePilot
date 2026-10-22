import SwiftUI
import AppKit

@main
struct TonePilotApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("TonePilot", id: "main") {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 1040, minHeight: 720)
                .preferredColorScheme(.light)
                .tint(Theme.accent)
                .task { await model.launch(); await Snapshot.runIfRequested(model) }
        }
        .defaultSize(width: 1200, height: 840)
        .windowStyle(.hiddenTitleBar)
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
        MenuBarExtra("TonePilot", systemImage: "circle.lefthalf.filled") {
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

// Charcoal rail for navigation and status on the left; warm paper canvas for the work.
struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            Rail().frame(width: 272)
            VStack(spacing: 0) {
                if let op = model.operation, op.kind != .doctor || model.doctor == nil { ProgressPanel(op: op) }
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.paper)
        }
        .background(Theme.paper)
        .ignoresSafeArea(.container, edges: .top)
        .foregroundStyle(Theme.ink)
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
                Page { Callout(tone: .danger, systemImage: "doc.badge.ellipsis", title: "This session can't be opened", message: error) }
            } else { ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
    }
}

// Scrolling paper page with consistent margins, used by every screen.
struct Page<Content: View>: View {
    var maxWidth: CGFloat = 820
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: maxWidth, alignment: .leading)
                .padding(.horizontal, 40).padding(.top, 44).padding(.bottom, 28)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.automatic)
    }
}

// MARK: Rail

private struct Rail: View {
    @EnvironmentObject var model: AppModel

    private var current: [SessionSummary] { model.sessions.filter { !$0.isLegacy && $0.attention != true && $0.status != "discarded" } }
    private var legacy: [SessionSummary] { model.sessions.filter(\.isLegacy) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand.padding(.top, 46).padding(.bottom, 22)
            Theme.cream.opacity(0.14).frame(height: 1)
            VStack(alignment: .leading, spacing: 2) {
                RailItem(title: "New first pass", systemImage: "plus.circle", selected: model.route == .newPass) { model.route = .newPass }
                RailItem(title: "Setup", systemImage: "checklist", selected: model.route == .setup,
                         badge: model.doctor != nil && !model.ready ? Theme.danger : nil) { model.route = .setup }
            }
            .padding(.vertical, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if !model.attentionSessions.isEmpty {
                        RailHeading(text: "Needs attention", color: Theme.accentLight)
                        ForEach(model.attentionSessions) { SessionRailRow(s: $0) }
                    }
                    RailHeading(text: "Sessions", color: Theme.railText)
                    if current.isEmpty && model.attentionSessions.isEmpty {
                        Text("Your first pass will appear here.").font(Theme.secondary).foregroundStyle(Theme.railText)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                    }
                    ForEach(current) { SessionRailRow(s: $0) }
                    if !legacy.isEmpty {
                        RailHeading(text: "Earlier versions", color: Theme.railText.opacity(0.75))
                        ForEach(legacy) { SessionRailRow(s: $0, dim: true) }
                    }
                }
                .padding(.bottom, 12)
            }
            .scrollIndicators(.never)
            Spacer(minLength: 0)
            connection
        }
        .padding(.horizontal, 16)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.rail)
    }

    private var brand: some View {
        HStack(spacing: 12) {
            Monogram().frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text("TonePilot").font(Theme.serif(24, .bold)).tracking(-0.8).foregroundStyle(Theme.cream)
                Text("FOR LIGHTROOM CLASSIC").font(.system(size: 10.5, weight: .bold)).tracking(1.3).foregroundStyle(Theme.accentLight)
                    .lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("TonePilot for Lightroom Classic")
    }

    private var connection: some View {
        let live = model.doctor?.checks.first { $0.id == "live-bridge" }
        let ok = live?.ok == true
        return VStack(alignment: .leading, spacing: 0) {
            Theme.cream.opacity(0.14).frame(height: 1)
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(ok ? Theme.verified : model.doctor == nil ? Theme.railText : Theme.danger).frame(width: 9, height: 9).padding(.top, 4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ok ? "Lightroom connected" : model.doctor == nil ? "Checking Lightroom…" : "Lightroom not connected")
                        .font(Theme.secondaryStrong).foregroundStyle(Theme.cream)
                    if let d = live?.detail { Text(d).font(Theme.secondary).foregroundStyle(Theme.railText).lineLimit(2) }
                }
                Spacer(minLength: 4)
                Button { Task { await model.checkSetup() } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.accentLight)
                        .frame(width: 28, height: 28).background(Theme.railRaised, in: Circle())
                }
                .buttonStyle(.plain).help("Check the Lightroom connection again").disabled(model.busy)
                .accessibilityLabel("Check the Lightroom connection again")
            }
            .padding(.vertical, 16).padding(.horizontal, 4)
        }
    }
}

private struct RailHeading: View {
    let text: String; let color: Color
    var body: some View {
        Text(text.uppercased()).font(.system(size: 11.5, weight: .bold)).tracking(1.6).foregroundStyle(color)
            .padding(.horizontal, 12).padding(.top, 16).padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct RailItem: View {
    let title: String; let systemImage: String; let selected: Bool
    var badge: Color? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: systemImage).font(.system(size: 15, weight: .semibold)).frame(width: 20)
                    .foregroundStyle(selected ? Theme.accentLight : Theme.railText)
                Text(title).font(.system(size: 15, weight: selected ? .semibold : .medium))
                    .foregroundStyle(selected ? Theme.cream : Theme.cream.opacity(0.82))
                Spacer()
                if let badge { Circle().fill(badge).frame(width: 8, height: 8) }
            }
            .padding(.horizontal, 12).frame(height: 38)
            .background(selected ? Theme.railRaised : .clear, in: RoundedRectangle(cornerRadius: 9))
            .overlay(alignment: .leading) { if selected { Theme.accent.frame(width: 3, height: 18).clipShape(Capsule()) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct SessionRailRow: View {
    @EnvironmentObject var model: AppModel
    let s: SessionSummary
    var dim = false
    private var selected: Bool { model.route == .session(s.id) }
    var body: some View {
        Button { Task { await model.open(s.id) } } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(Format.date(s.created)).font(Theme.serif(15)).monospacedDigit()
                        .foregroundStyle(Theme.cream.opacity(dim ? 0.6 : 1))
                    Spacer(minLength: 6)
                    if s.running != nil { ProgressView().controlSize(.mini).tint(Theme.accentLight) }
                    else { Text(Format.plural(s.photoCount ?? 0, "photo")).font(Theme.secondary).foregroundStyle(Theme.railText.opacity(dim ? 0.7 : 1)) }
                }
                HStack(spacing: 6) {
                    Circle().fill(sessionTone(s.status).color).frame(width: 7, height: 7)
                    Text(s.isLegacy ? "TonePilot 0.4 · no changes" : s.label).font(Theme.secondary).lineLimit(1)
                }
                .foregroundStyle(Theme.railText.opacity(dim ? 0.75 : 1))
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.railRaised : .clear, in: RoundedRectangle(cornerRadius: 9))
            .overlay(alignment: .leading) { if selected { Theme.accent.frame(width: 3, height: 22).clipShape(Capsule()) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

// MARK: Progress

private struct ProgressPanel: View {
    @EnvironmentObject var model: AppModel
    let op: Operation
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                ProgressView().controlSize(.small).tint(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(op.title).font(Theme.serif(16)).foregroundStyle(Theme.ink)
                    if !op.detail.isEmpty {
                        Text(op.detail + (op.index.map { i in op.total.map { " — \(i) of \($0)" } ?? "" } ?? ""))
                            .font(Theme.secondary).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                Spacer()
                if [.analyze, .apply, .restore].contains(op.kind) {
                    Button(op.stopping ? "Stopping…" : "Stop") { model.stop() }
                        .buttonStyle(QuietButtonStyle()).disabled(op.stopping)
                        .help("Finishes the photo being written, then stops (Esc)")
                }
            }
            .padding(.horizontal, 40).padding(.top, 34).padding(.bottom, 12)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Theme.line
                    Theme.accent.frame(width: g.size.width * (op.fraction ?? 0.08))
                }
            }
            .frame(height: 3)
        }
        .background(Theme.card)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Earlier-version session

private struct LegacySessionView: View {
    @EnvironmentObject var model: AppModel
    let summary: SessionSummary
    var body: some View {
        Page(maxWidth: 680) {
            SectionLabel(step: nil, title: "Earlier version")
            Text("A TonePilot 0.4 session").font(Theme.display).tracking(-1.4).padding(.top, 10)
            Text([Format.date(summary.created), Format.plural(summary.photoCount ?? 0, "photo"), summary.look, summary.strength]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(Theme.body).foregroundStyle(Theme.muted).padding(.top, 6)
            PaperCard {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: summary.attention == true ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(summary.attention == true ? Theme.attention : Theme.verified)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(summary.explanation ?? "").font(Theme.serif(17)).fixedSize(horizontal: false, vertical: true)
                        Text("TonePilot 0.5 records every session in a crash-safe journal. Sessions from 0.4 are kept for reference and can't be applied or restored from here.")
                            .font(Theme.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.top, 22)
            HStack(spacing: 12) {
                Button { model.route = .newPass } label: { Label("Start a new first pass", systemImage: "arrow.right") }
                    .buttonStyle(PrimaryButtonStyle()).labelStyle(TrailingIconLabelStyle())
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: summary.dir)]) }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.top, 18)
        }
    }
}
