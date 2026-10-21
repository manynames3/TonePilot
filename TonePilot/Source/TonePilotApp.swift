import SwiftUI
import AppKit

enum Screen: String, CaseIterable {
    case workspace = "Edit"
    case sessions = "Review"
    case activity = "Activity"
    case help = "Help"
}

@main
struct TonePilotApp: App {
    @StateObject private var model = WorkspaceModel()

    var body: some Scene {
        WindowGroup(id: "main") {
            TonePilotView()
                .environmentObject(model)
                .frame(minWidth: 424, minHeight: 548)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 520, height: 890)
        .windowResizability(.contentSize)
        .windowStyle(.titleBar)

        MenuBarExtra("TonePilot", systemImage: "camera.aperture") {
            TonePilotMenu()
                .environmentObject(model)
        }
        .menuBarExtraStyle(.menu)
    }
}

private enum ToneStyle {
    static let accent = Color(red: 0.46, green: 0.67, blue: 1)
    static let bg = Color(red: 0.095, green: 0.101, blue: 0.117)
    static let surface = Color(red: 0.137, green: 0.146, blue: 0.167)
    static let line = Color.white.opacity(0.085)
    static let muted = Color.white.opacity(0.58)
}

struct TonePilotMenu: View {
    @EnvironmentObject private var model: WorkspaceModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open TonePilot") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Text(model.lightroomOpen ? "Lightroom Classic: open" : "Lightroom Classic: closed")
        Text(model.bridgeInstalled ? "Lightroom bridge: installed" : "Lightroom bridge: missing")
        Button("Refresh connections") { model.refresh() }
        Button("Open Lightroom") { model.openLightroom() }
        Divider()
        Button("Quit TonePilot") { NSApp.terminate(nil) }
    }
}

struct TonePilotView: View {
    @EnvironmentObject private var model: WorkspaceModel
    @AppStorage("tonepilot.style") private var style = "Natural"
    @AppStorage("tonepilot.strength") private var strength = "Balanced"
    @AppStorage("tonepilot.wb") private var wb = true
    @AppStorage("tonepilot.exposure") private var exposure = true
    @AppStorage("tonepilot.tone") private var tone = true

    private var canRun: Bool {
        model.scanComplete && !model.photos.isEmpty && model.photos.count <= 20 &&
        !model.busy && model.codexReady && model.bridgeInstalled &&
        model.lightroomOpen && (wb || exposure || tone)
    }

    var body: some View {
        VStack(spacing: 0) {
            appHeader
            nav
            Rectangle().fill(ToneStyle.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 21) {
                    switch model.screen {
                    case .workspace: workspace
                    case .sessions: review
                    case .activity: activity
                    case .help: help
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(21)
            }
            .scrollIndicators(.automatic)
            Rectangle().fill(ToneStyle.line).frame(height: 1)
            bottomBar
        }
        .background(ToneStyle.bg)
        .alert("TonePilot", isPresented: Binding(
            get: { model.alertMessage != nil },
            set: { if !$0 { model.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.alertMessage = nil }
        } message: {
            Text(model.alertMessage ?? "")
        }
    }

    private var appHeader: some View {
        HStack(spacing: 11) {
            Image(systemName: "camera.aperture")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(ToneStyle.accent)
                .frame(width: 37, height: 37)
                .background(ToneStyle.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 2) {
                Text("TonePilot")
                    .font(.system(size: 19, weight: .semibold, design: .rounded))
                    .tracking(-0.4)
                Text("LIGHTROOM COMPANION")
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(1.25)
                    .foregroundStyle(ToneStyle.muted)
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                Circle()
                    .fill(model.scanComplete && !model.photos.isEmpty ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text(model.scanComplete && !model.photos.isEmpty ? "Selected" : (model.lightroomOpen && model.bridgeInstalled && model.codexReady ? "Detected" : "Setup"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white.opacity(0.8))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.white.opacity(0.065), in: Capsule())
            .help("Detected means prerequisites are found; the live connection is verified only by Sync selection.")
        }
        .padding(.horizontal, 21)
        .padding(.top, 15)
        .padding(.bottom, 17)
    }

    private var nav: some View {
        HStack(spacing: 3) {
            ForEach(Screen.allCases, id: \.self) { screen in
                Button {
                    model.screen = screen
                    if screen == .sessions { model.refreshSessions() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: icon(for: screen))
                            .font(.system(size: 11))
                        Text(screen.rawValue)
                            .font(.system(size: 12, weight: model.screen == screen ? .semibold : .medium))
                    }
                    .foregroundStyle(model.screen == screen ? .white : ToneStyle.muted)
                    .frame(maxWidth: .infinity)
                    .frame(height: 34)
                    .background(model.screen == screen ? ToneStyle.surface : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 19)
        .padding(.bottom, 15)
    }

    private func icon(for screen: Screen) -> String {
        switch screen {
        case .workspace: return "slider.horizontal.3"
        case .sessions: return "checkmark.circle"
        case .activity: return "waveform.path"
        case .help: return "questionmark.circle"
        }
    }

    private var workspace: some View {
        VStack(alignment: .leading, spacing: 21) {
            connectionSection
            selectionSection
            editSection
            if !model.report.isEmpty { compactReport }
        }
    }

    private var connectionSection: some View {
        VStack(alignment: .leading, spacing: 11) {
            sectionHeader("Lightroom connection", accessory: "arrow.clockwise") { model.refresh() }
            HStack(spacing: 11) {
                Image(systemName: "photo")
                    .font(.system(size: 16))
                    .foregroundStyle(ToneStyle.accent)
                    .frame(width: 33, height: 33)
                    .background(ToneStyle.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Adobe Lightroom Classic")
                        .font(.system(size: 12, weight: .semibold))
                    Text(connectionDetail)
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToneStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                if !model.lightroomOpen {
                    Button("Open") { model.openLightroom() }
                        .buttonStyle(QuietButton())
                } else {
                    Image(systemName: model.bridgeInstalled && model.codexReady ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .foregroundStyle(model.bridgeInstalled && model.codexReady ? .green : .orange)
                }
            }
            .padding(12)
            .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var connectionDetail: String {
        if !model.lightroomInstalled { return "Lightroom Classic not found" }
        if !model.lightroomOpen { return "Not running — open Lightroom to continue" }
        if !model.bridgeInstalled { return "Lightroom MCP plug-in missing" }
        if !model.codexReady { return "AI engine (Codex) not found" }
        return "App open · Plug-in installed · AI available — sync to verify"
    }

    private var selectionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Current selection")
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.scanComplete ? "\(model.photos.count)" : "—")
                        .font(.system(size: 41, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text(model.scanComplete ? (model.photos.count == 1 ? "photo selected in Lightroom" : "photos selected in Lightroom") : "Choose photos in Lightroom first")
                        .font(.system(size: 11))
                        .foregroundStyle(ToneStyle.muted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 8) {
                    Text("PILOT · MAX 20")
                        .font(.system(size: 9, weight: .semibold))
                        .tracking(0.8)
                        .foregroundStyle(ToneStyle.muted)
                    Button {
                        model.scanSelection()
                    } label: {
                        HStack(spacing: 6) {
                            if model.busy && model.phase == "Reading selection" {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                            Text(model.busy ? "Working…" : "Sync selection")
                        }
                    }
                    .disabled(model.busy || !model.lightroomOpen || !model.codexReady || !model.bridgeInstalled)
                    .buttonStyle(AccentButton())
                }
            }
            .padding(15)
            .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 13))
            if model.scanComplete && !model.photos.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.green)
                    Text(selectionDescription)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(size: 10.5))
                .foregroundStyle(ToneStyle.muted)
                .padding(.horizontal, 2)
            }
        }
    }

    private var selectionDescription: String {
        let names = model.photos.prefix(2).map(\.filename).joined(separator: ", ")
        return model.photos.count > 2 ? "\(names) and \(model.photos.count - 2) more" : names
    }

    private var editSection: some View {
        VStack(alignment: .leading, spacing: 17) {
            sectionHeader("AI first-pass settings")
            VStack(alignment: .leading, spacing: 10) {
                smallLabel("EDITING LOOK")
                Picker("Editing look", selection: $style) {
                    Text("Natural").tag("Natural")
                    Text("Soft & airy").tag("Soft & airy")
                    Text("Scene mood").tag("True to scene")
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .controlSize(.regular)
            }
            VStack(alignment: .leading, spacing: 10) {
                smallLabel("CORRECTION STRENGTH")
                Picker("Correction strength", selection: $strength) {
                    Text("Subtle").tag("Subtle")
                    Text("Balanced").tag("Balanced")
                    Text("Stronger").tag("Stronger")
                }
                .labelsHidden()
                .pickerStyle(.segmented)
            }
            Rectangle().fill(ToneStyle.line).frame(height: 1)
            VStack(spacing: 13) {
                correction("White balance & skin tone",
                           note: "Temperature, tint and natural skin",
                           symbol: "eyedropper", isOn: $wb)
                correction("Exposure",
                           note: "Subject brightness and highlights",
                           symbol: "sun.max", isOn: $exposure)
                correction("Tone & contrast",
                           note: "Shadows and white/black points",
                           symbol: "circle.lefthalf.filled", isOn: $tone)
            }
        }
    }

    private var compactReport: some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Last edit completed")
            Text(model.phase)
                .font(.system(size: 12, weight: .medium))
            Button("Review results") {
                model.screen = .sessions
                model.refreshSessions()
            }
            .buttonStyle(QuietButton())
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 11) {
            if model.busy {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text(model.phase)
                        .font(.system(size: 11))
                        .foregroundStyle(ToneStyle.muted)
                        .lineLimit(1)
                    Spacer()
                    Button("Stop") { model.stop() }
                        .buttonStyle(QuietButton())
                }
            }
            Button {
                model.startFirstPass(style: style, strength: strength,
                                     wb: wb, exposure: exposure, tone: tone)
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "sparkles")
                    Text("Run AI First Pass")
                    Spacer()
                    Text(model.scanComplete ? "\(model.photos.count) photos" : "Select photos")
                        .font(.system(size: 10, weight: .medium))
                        .opacity(0.8)
                    Image(systemName: "arrow.right")
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(!canRun)
            .buttonStyle(AccentButton(large: true))
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .foregroundStyle(Color.green.opacity(0.85))
                Text("No duplicate previews · Nondestructive · No auto-export")
                    .font(.system(size: 10))
                    .foregroundStyle(ToneStyle.muted)
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 15)
        .background(ToneStyle.bg)
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 15) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Your review")
                    .font(.system(size: 23, weight: .semibold, design: .rounded))
                Text("AI adjustments live in Lightroom. Reports explain what changed and which photos need attention.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToneStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.sessions.isEmpty {
                emptyState("No completed sessions yet",
                           detail: "After your first pass, the report appears here.",
                           icon: "checkmark.seal")
            } else {
                ForEach(model.sessions.prefix(16)) { session in
                    Button {
                        model.selectReport(session)
                    } label: {
                        HStack(spacing: 11) {
                            Image(systemName: "doc.text")
                                .font(.system(size: 17))
                                .foregroundStyle(ToneStyle.accent)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(session.title)
                                    .font(.system(size: 12, weight: .medium))
                                Text(session.date, style: .date)
                                    .font(.system(size: 10))
                                    .foregroundStyle(ToneStyle.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11))
                                .foregroundStyle(ToneStyle.muted)
                        }
                        .padding(13)
                        .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 11))
                    }
                    .buttonStyle(.plain)
                }
            }
            if !model.report.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    sectionHeader("Review notes")
                    Text(.init(String(model.report.prefix(6500))))
                        .font(.system(size: 11.5))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack {
                        Button("Open full report") { model.openReport() }
                            .buttonStyle(QuietButton())
                        Button("Open Lightroom") { model.openLightroom() }
                            .buttonStyle(QuietButton())
                    }
                }
                .padding(14)
                .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var activity: some View {
        VStack(alignment: .leading, spacing: 13) {
            sectionHeader("Live activity")
            Text(model.phase)
                .font(.system(size: 15, weight: .semibold))
            if model.events.isEmpty {
                emptyState("Nothing running yet",
                           detail: "Progress will appear here while TonePilot works with Lightroom.",
                           icon: "waveform.path")
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(model.events.reversed().enumerated()), id: \.offset) { _, event in
                        Text(event)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ToneStyle.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(14)
                .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            Button("Open session folder") { model.openProject() }
                .buttonStyle(QuietButton())
        }
    }

    private var help: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("A little intelligence, right beside Lightroom.")
                .font(.system(size: 23, weight: .semibold, design: .rounded))
                .fixedSize(horizontal: false, vertical: true)
            helpStep("1", "Open Lightroom Classic",
                     "Work normally in your catalog. TonePilot doesn't duplicate your library.")
            helpStep("2", "Select your pilot photos",
                     "Choose up to 20 test photos in Lightroom's filmstrip.")
            helpStep("3", "Sync the selection",
                     "Return to Edit and click Sync selection to confirm the count.")
            helpStep("4", "Let AI make a first pass",
                     "Choose your look, run the edit, and review changes in Lightroom.")
            Divider().overlay(ToneStyle.line)
            Text("Connection troubleshooting")
                .font(.system(size: 12, weight: .semibold))
            Text("If a scan cannot connect, open Lightroom → File → Plug-in Manager → Lightroom MCP and choose Start Server. After initial installation, restart Lightroom once.")
                .font(.system(size: 11))
                .foregroundStyle(ToneStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Open Lightroom") { model.openLightroom() }
                    .buttonStyle(QuietButton())
                Button("Open project folder") { model.openProject() }
                    .buttonStyle(QuietButton())
            }
        }
    }

    private func helpStep(_ number: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ToneStyle.accent)
                .frame(width: 28, height: 28)
                .background(ToneStyle.accent.opacity(0.10), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 12, weight: .semibold))
                Text(detail).font(.system(size: 11)).foregroundStyle(ToneStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 11))
    }

    private func sectionHeader(_ title: String, accessory: String? = nil,
                               action: (() -> Void)? = nil) -> some View {
        HStack {
            Text(title).font(.system(size: 13, weight: .semibold))
            Spacer()
            if let accessory, let action {
                Button(action: action) {
                    Image(systemName: accessory)
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(ToneStyle.muted)
                .help("Refresh connection status")
            }
        }
    }

    private func smallLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9.5, weight: .semibold))
            .tracking(1.25)
            .foregroundStyle(ToneStyle.muted)
    }

    private func correction(_ title: String, note: String, symbol: String,
                            isOn: Binding<Bool>) -> some View {
        HStack(spacing: 11) {
            Image(systemName: symbol)
                .font(.system(size: 16))
                .foregroundStyle(ToneStyle.accent)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                Text(note)
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToneStyle.muted)
            }
            Spacer(minLength: 5)
            Toggle(title, isOn: isOn)
                .labelsHidden()
                .tint(ToneStyle.accent)
                .controlSize(.small)
        }
    }

    private func emptyState(_ title: String, detail: String, icon: String) -> some View {
        VStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 29, weight: .ultraLight))
                .foregroundStyle(ToneStyle.accent)
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(detail)
                .font(.system(size: 11))
                .foregroundStyle(ToneStyle.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
        .padding(.horizontal, 18)
        .background(ToneStyle.surface, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct AccentButton: ButtonStyle {
    var large = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: large ? 12.5 : 11.5, weight: .semibold))
            .foregroundStyle(Color(red: 0.075, green: 0.10, blue: 0.16))
            .padding(.horizontal, large ? 17 : 13)
            .frame(minHeight: large ? 44 : 34)
            .background(ToneStyle.accent, in: RoundedRectangle(cornerRadius: 9))
            .opacity(isEnabled ? (configuration.isPressed ? 0.77 : 1) : 0.35)
            .contentShape(RoundedRectangle(cornerRadius: 9))
    }
}

struct QuietButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(.white.opacity(0.84))
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            .background(Color.white.opacity(0.095), in: RoundedRectangle(cornerRadius: 9))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)
            .contentShape(RoundedRectangle(cornerRadius: 9))
    }
}
