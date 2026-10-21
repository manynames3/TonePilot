import SwiftUI
import AppKit

// MARK: - App
enum Screen: String, CaseIterable { case workspace = "Edit", sessions = "Reports", activity = "Activity", help = "Help" }
enum Panel: String, Identifiable { case reports, activity, help, settings; var id: String { rawValue } }

@main
struct TonePilotApp: App {
    @StateObject private var model = WorkspaceModel()
    var body: some Scene {
        WindowGroup(id: "main") {
            EditorialWorkspace()
                .environmentObject(model)
                .frame(minWidth: 860, minHeight: 725)
                .preferredColorScheme(.light)
        }
        .defaultSize(width: 1010, height: 870)
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
        MenuBarExtra("TonePilot", systemImage: "circle.lefthalf.filled") {
            Button("Open TonePilot") {
                NSApp.activate(ignoringOtherApps: true)
                NSApp.windows.first(where: { $0.canBecomeKey })?.makeKeyAndOrderFront(nil)
            }
            Divider()
            Text(model.scanComplete ? "Lightroom selection checked" : "Selection not yet verified")
            Button("Refresh connections") { model.refresh() }
            Button("Open Lightroom") { model.openLightroom() }
            Divider()
            Button("Quit TonePilot") { NSApp.terminate(nil) }
        }
    }
}

// MARK: - Theme
private enum Editorial {
    static let paper = Color(red: 0.969, green: 0.954, blue: 0.930)
    static let card = Color(red: 0.992, green: 0.980, blue: 0.962)
    static let ink = Color(red: 0.130, green: 0.122, blue: 0.114)
    static let muted = Color(red: 0.410, green: 0.385, blue: 0.370)
    static let line = Color(red: 0.79, green: 0.76, blue: 0.72).opacity(0.55)
    static let accent = Color(red: 0.726, green: 0.334, blue: 0.235)
    static let accentLight = Color(red: 0.87, green: 0.55, blue: 0.41)
    static let dark = Color(red: 0.123, green: 0.113, blue: 0.106)
    static let cream = Color(red: 0.963, green: 0.904, blue: 0.795)
    static let softText = Color(red: 0.74, green: 0.69, blue: 0.65)
    static let success = Color(red: 0.32, green: 0.62, blue: 0.37)
}

// MARK: - Main view
struct EditorialWorkspace: View {
    @EnvironmentObject private var model: WorkspaceModel
    @AppStorage("tonepilot.style") private var selectedLook = "Natural"
    @AppStorage("tonepilot.strength") private var strength = "Balanced"
    @AppStorage("tonepilot.wb") private var whiteBalance = true
    @AppStorage("tonepilot.exposure") private var exposure = true
    @AppStorage("tonepilot.tone") private var tone = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var scanning: Bool { model.busy && model.phase == "Reading selection" }
    private var editing: Bool { model.busy && !scanning }
    private var selectedCount: Int { model.scanComplete ? model.photos.count : 0 }
    private var liveConnected: Bool { model.scanComplete && model.lightroomOpen && model.bridgeInstalled && model.codexReady }
    private var validSelection: Bool { model.scanComplete && (1...20).contains(model.photos.count) }
    private var canRun: Bool {
        validSelection && !model.busy && model.lightroomOpen &&
        model.bridgeInstalled && model.codexReady &&
        (whiteBalance || exposure || tone)
    }
    private var canSync: Bool {
        !model.busy && model.lightroomOpen && model.bridgeInstalled && model.codexReady
    }
    private var canOpenLightroom: Bool {
        !model.busy && model.lightroomInstalled && !model.lightroomOpen
    }
    private var primaryReady: Bool {
        canOpenLightroom || canRun || (!validSelection && canSync)
    }
    private var primaryTitle: String {
        if scanning { return "Reading Lightroom selection…" }
        if canOpenLightroom { return "Open Lightroom Classic" }
        if canRun { return "Create AI First Pass" }
        if canSync && !validSelection {
            return model.scanComplete ? "Update Lightroom selection" : "Read Lightroom selection"
        }
        return issue
    }
    private var issue: String {
        if !model.lightroomOpen { return "Open Lightroom Classic to begin" }
        if !model.bridgeInstalled { return "Install Lightroom MCP to continue" }
        if !model.codexReady { return "Connect Codex to continue" }
        if !model.scanComplete { return "Read your Lightroom selection first" }
        if model.photos.isEmpty { return "Select photos in Lightroom first" }
        if model.photos.count > 20 { return "Reduce your selection to 20 photos" }
        if !whiteBalance && !exposure && !tone { return "Enable at least one correction" }
        return "Create AI First Pass"
    }

    var body: some View {
        GeometryReader { geometry in
            let railWidth = max(255, min(318, geometry.size.width * 0.302))
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    topBar
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            sectionSelection
                            sectionRule
                            sectionLooks
                            sectionRule
                            sectionStrength
                            sectionRule
                            sectionCorrections
                        }
                        .padding(.horizontal, 30)
                        .padding(.bottom, 14)
                    }
                    .scrollIndicators(.automatic)
                    .background(Editorial.paper)
                    bottomAction
                }
                .frame(maxWidth: .infinity)
                .background(Editorial.paper)
                EditorialSideRail(
                    openReports: { model.refreshSessions(); model.panel = .reports },
                    openHelp: { model.panel = .help },
                    openSettings: { model.panel = .settings }
                )
                .frame(width: railWidth)
            }
            .background(Editorial.paper)
        }
        .sheet(item: $model.panel) { panel in
            supportingSheet(panel)
                .frame(minWidth: 530, minHeight: 460)
                .preferredColorScheme(.light)
        }
        .alert("TonePilot", isPresented: Binding(
            get: { model.alertMessage != nil },
            set: { if !$0 { model.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.alertMessage = nil }
        } message: {
            Text(model.alertMessage ?? "")
        }
        .onAppear { model.refresh() }
    }

    private var topBar: some View {
        HStack(alignment: .center, spacing: 13) {
            // Native traffic lights occupy the top-left corner of this hidden-title-bar window.
            Spacer().frame(width: 57)
            TonePilotMonogram().frame(width: 43, height: 43)
            VStack(alignment: .leading, spacing: 2) {
                Text("TonePilot")
                    .font(.system(size: 29, weight: .semibold, design: .serif))
                    .tracking(-1.2)
                    .foregroundStyle(Editorial.ink)
                Text("FOR LIGHTROOM CLASSIC")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(2.0)
                    .foregroundStyle(Editorial.muted)
            }
            Spacer(minLength: 5)
            Menu {
                Text(liveConnected ? "Live selection verified" : "Not yet verified")
                Divider()
                Button("Read Lightroom selection") { model.scanSelection() }
                    .disabled(model.busy || !model.lightroomOpen || !model.bridgeInstalled || !model.codexReady)
                Button("Refresh prerequisites") { model.refresh() }
                Button("Open Lightroom Classic") { model.openLightroom() }
                Divider()
                Button("Connection help") { model.panel = .help }
            } label: {
                HStack(spacing: 7) {
                    Circle()
                        .fill(liveConnected ? Editorial.success : Editorial.accentLight)
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(liveConnected ? "Connected" : "Not verified")
                            .font(.system(size: 13, weight: .bold))
                        Text("Lightroom Classic")
                            .font(.system(size: 12, weight: .medium))
                    }
                }
                .foregroundStyle(Editorial.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 46)
                .background(Editorial.card, in: RoundedRectangle(cornerRadius: 11))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(Editorial.line, lineWidth: 0.7))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Connection is verified only after a successful Lightroom selection read")
        }
        .padding(.horizontal, 21)
        .frame(height: 79)
        .background(Editorial.paper)
    }

    private var sectionSelection: some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeading("STEP 1", subtitle: "YOUR SELECTION")
            if validSelection {
                Text("\(model.photos.count) photos selected")
                    .font(.system(size: 37, weight: .bold, design: .serif))
                    .tracking(-1.8)
                    .foregroundStyle(Editorial.ink)
                    .lineLimit(1).minimumScaleFactor(0.76)
            } else {
                Text(model.scanComplete && model.photos.count > 20 ? "\(model.photos.count) photos selected" : "Choose your photos")
                    .font(.system(size: 37, weight: .bold, design: .serif))
                    .tracking(-1.8)
                    .foregroundStyle(Editorial.ink)
                    .lineLimit(1).minimumScaleFactor(0.74)
            }
            Text(validSelection
                 ? "Your photographs are ready for a considered first pass."
                 : "Select up to 20 photos in Lightroom, then read your selection.")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Editorial.muted)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(2)

            HStack(spacing: 13) {
                Image(systemName: validSelection ? "square.stack.3d.up" : "photo.on.rectangle.angled")
                    .font(.system(size: 23, weight: .regular))
                    .foregroundStyle(Editorial.ink)
                    .frame(width: 35)
                VStack(alignment: .leading, spacing: 3) {
                    Text(validSelection ? "\(model.photos.count) photos" : "Lightroom selection")
                        .font(.system(size: 16, weight: .semibold, design: .serif))
                        .foregroundStyle(Editorial.ink)
                    Text(validSelection ? selectionFilenames : (model.scanComplete ? "No valid pilot selection yet" : "Awaiting your selection"))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Editorial.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 2)
                Button {
                    model.scanSelection()
                } label: {
                    HStack(spacing: 7) {
                        if scanning { ProgressView().controlSize(.small) }
                        else { Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .bold)) }
                        Text(scanning ? "Reading…" : (validSelection ? "Update selection" : "Read selection"))
                            .font(.system(size: 14, weight: .bold))
                    }
                    .lineLimit(1)
                    .padding(.horizontal, 13)
                    .frame(minHeight: 38)
                    .background(Editorial.card, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Editorial.accent.opacity(0.52), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Editorial.ink)
                .disabled(model.busy || !model.lightroomOpen || !model.bridgeInstalled || !model.codexReady)
                .opacity(model.busy ? 0.6 : 1)
                .keyboardShortcut("r", modifiers: [.command])
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 8)
            .background(Color(red: 0.941, green: 0.922, blue: 0.894), in: RoundedRectangle(cornerRadius: 14))

            if model.scanComplete && model.photos.count > 20 {
                Label("Pilot is limited to 20 photos. Reduce your Lightroom selection.", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Editorial.accent)
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 12)
    }

    private var selectionFilenames: String {
        let names = model.photos.prefix(2).map(\.filename).joined(separator: " · ")
        return model.photos.count > 2 ? "\(names) +\(model.photos.count - 2)" : names
    }

    private var sectionLooks: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                sectionHeading("STEP 2", subtitle: "CHOOSE A LOOK")
                Spacer()
                Text("YOUR STYLE")
                    .font(.system(size: 13, weight: .bold))
                    .tracking(1.0)
                    .foregroundStyle(Editorial.muted)
            }
            HStack(spacing: 11) {
                lookTile("Natural", subtitle: "TRUE TO LIFE", variant: 0)
                lookTile("Soft & airy", subtitle: "GENTLE LIGHT", variant: 1)
                lookTile("Scene mood", subtitle: "KEEP ATMOSPHERE", variant: 2)
            }
            .frame(height: 125)
        }
        .padding(.vertical, 11)
    }

    private func lookTile(_ label: String, subtitle: String, variant: Int) -> some View {
        let value = variant == 2 ? "True to scene" : label
        let active = selectedLook == value
        return Button {
            withAnimation(.easeOut(duration: reduceMotion ? 0 : 0.2)) { selectedLook = value }
        } label: {
            ZStack(alignment: .bottomLeading) {
                LookArtwork(variant: variant)
                    .overlay {
                        LinearGradient(colors: [.clear, .black.opacity(0.08), .black.opacity(0.78)],
                                       startPoint: .top, endPoint: .bottom)
                    }
                VStack(alignment: .leading, spacing: 4) {
                    Text(label)
                        .font(.system(size: 18, weight: .semibold, design: .serif))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Text(subtitle)
                        .font(.system(size: 12, weight: .bold))
                        .tracking(0.3)
                        .foregroundStyle(.white.opacity(0.93))
                        .lineLimit(1)
                        .minimumScaleFactor(0.81)
                }
                .padding(.horizontal, 13)
                .padding(.bottom, 14)
                VStack {
                    HStack {
                        Spacer()
                        Image(systemName: active ? "checkmark.circle.fill" : "circle")
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(active ? .white : .white.opacity(0.90),
                                             active ? Editorial.accent : .white.opacity(0.10))
                            .font(.system(size: 20, weight: .medium))
                    }
                    Spacer()
                }
                .padding(11)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(active ? Editorial.accent : Editorial.line, lineWidth: active ? 2.5 : 0.8)
            }
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("\(label), \(subtitle), \(active ? "selected" : "not selected")")
    }

    private var sectionStrength: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                sectionHeading("STEP 3", subtitle: "ADJUST STRENGTH")
                Spacer()
                Text(strength)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .frame(height: 27)
                    .background(Editorial.accent, in: RoundedRectangle(cornerRadius: 7))
            }
            HStack(spacing: 0) {
                strengthStop("Subtle", at: 0)
                strengthStop("Balanced", at: 1)
                strengthStop("Stronger", at: 2)
            }
        }
        .padding(.vertical, 9)
    }

    private func strengthStop(_ value: String, at index: Int) -> some View {
        let active = strength == value
        return Button {
            withAnimation(.easeOut(duration: reduceMotion ? 0 : 0.18)) { strength = value }
        } label: {
            VStack(spacing: 10) {
                ZStack {
                    Rectangle().fill(Editorial.line).frame(height: 4)
                    Circle()
                        .fill(active ? Editorial.accent : Color(red: 0.76, green: 0.72, blue: 0.69))
                        .frame(width: active ? 21 : 15, height: active ? 21 : 15)
                        .overlay(Circle().stroke(Editorial.paper, lineWidth: active ? 3 : 1.5))
                }
                Text(value)
                    .font(.system(size: 14, weight: active ? .bold : .medium))
                    .foregroundStyle(active ? Editorial.ink : Editorial.muted)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minHeight: 34)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private var sectionCorrections: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionHeading("STEP 4", subtitle: "WHAT TO CORRECT")
                Spacer()
                Text("\([whiteBalance, exposure, tone].filter { $0 }.count) OF 3 ENABLED")
                    .font(.system(size: 13, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(Editorial.muted)
            }
            VStack(spacing: 5) {
                correctionRow("White balance & skin",
                              "Temperature, tint and unwanted color casts",
                              icon: "circle.lefthalf.filled", on: $whiteBalance)
                correctionRow("Exposure",
                              "Subject brightness and preserved detail",
                              icon: "sun.max", on: $exposure)
                correctionRow("Highlights & shadows",
                              "Restore detail while preserving depth",
                              icon: "circle.dotted.circle", on: $tone)
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 3)
    }

    private func correctionRow(_ name: String, _ note: String, icon: String, on: Binding<Bool>) -> some View {
        Button {
            withAnimation(.easeOut(duration: reduceMotion ? 0 : 0.17)) { on.wrappedValue.toggle() }
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 23, weight: .regular))
                    .foregroundStyle(Editorial.accent)
                    .frame(width: 31, height: 35)
                VStack(alignment: .leading, spacing: 4) {
                    Text(name)
                        .font(.system(size: 16, weight: .semibold, design: .serif))
                        .foregroundStyle(Editorial.ink)
                    Text(note)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Editorial.muted)
                        .lineLimit(1).minimumScaleFactor(0.86)
                }
                Spacer(minLength: 7)
                Capsule()
                    .fill(on.wrappedValue ? Editorial.accent : Color.gray.opacity(0.3))
                    .frame(width: 44, height: 25)
                    .overlay(alignment: on.wrappedValue ? .trailing : .leading) {
                        Circle().fill(.white)
                            .frame(width: 19, height: 19)
                            .padding(3)
                    }
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 13)
            .frame(minHeight: 55)
            .background(Editorial.card, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Editorial.line, lineWidth: 0.55))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name), \(on.wrappedValue ? "enabled" : "disabled")")
    }

    private var bottomAction: some View {
        VStack(spacing: 8) {
            if editing {
                HStack(spacing: 10) {
                    ProgressView().tint(Editorial.accent)
                    Text(model.phase)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Editorial.ink)
                        .lineLimit(1)
                    Spacer()
                    Button("Stop") { model.stop() }
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Editorial.accent)
                        .buttonStyle(.plain)
                }
                .padding(.bottom, 3)
            }
            if !model.report.isEmpty && !model.busy {
                Button {
                    model.refreshSessions()
                    model.panel = .reports
                } label: {
                    Label("AI session report available — review results", systemImage: "doc.text")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Editorial.accent)
                }
                .buttonStyle(.plain)
            }
            if !editing {
            Button {
                if canRun {
                    model.startFirstPass(style: selectedLook, strength: strength,
                                         wb: whiteBalance, exposure: exposure, tone: tone)
                } else if canSync {
                    model.scanSelection()
                } else if canOpenLightroom {
                    model.openLightroom()
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 17, weight: .semibold))
                    Text(primaryTitle)
                        .font(.system(size: 17, weight: .bold, design: .serif))
                        .lineLimit(1)
                        .minimumScaleFactor(0.83)
                    Spacer(minLength: 0)
                    if primaryReady { Image(systemName: "arrow.right").font(.system(size: 16, weight: .bold)) }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .padding(.horizontal, 22)
            }
            .disabled(!primaryReady)
            .buttonStyle(EditorialPrimaryButton(enabled: primaryReady))
            .keyboardShortcut(.return, modifiers: [.command])
            .help(issue)
            }
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                Text("Experimental · Back up your catalog · Review in Lightroom")
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Editorial.muted)
        }
        .padding(.horizontal, 30)
        .padding(.top, 8)
        .padding(.bottom, 11)
        .background(Editorial.paper)
        .overlay(alignment: .top) { Editorial.line.frame(height: 0.7) }
    }

    private var sectionRule: some View { Editorial.line.frame(height: 0.8) }

    private func sectionHeading(_ step: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            Text(step)
                .font(.system(size: 13, weight: .bold))
                .tracking(1.5)
            Text("·")
                .font(.system(size: 15, weight: .bold))
            Text(subtitle)
                .font(.system(size: 13, weight: .bold))
                .tracking(1.6)
        }
        .foregroundStyle(Editorial.ink)
    }

    // MARK: Supporting sheets (real state, no fake previews)
    private func supportingSheet(_ destination: Panel) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    switch destination {
                    case .reports:
                        Text("Your editing reports")
                            .font(.system(size: 29, weight: .bold, design: .serif))
                        Text("Review the actual photographs and Develop changes in Lightroom Classic.")
                            .foregroundStyle(Editorial.muted)
                        if model.sessions.isEmpty { sheetInfo("No reports yet", "The first completed editing session will appear here.") }
                        ForEach(model.sessions) { session in
                            Button {
                                model.selectReport(session)
                            } label: {
                                HStack {
                                    Image(systemName: "doc.text")
                                    VStack(alignment: .leading) {
                                        Text(session.title).font(.system(size: 16, weight: .bold))
                                        Text(session.date, style: .date).font(.system(size: 13))
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                }
                                .foregroundStyle(Editorial.ink)
                                .padding(15)
                                .background(Editorial.card, in: RoundedRectangle(cornerRadius: 11))
                            }
                            .buttonStyle(.plain)
                        }
                        if !model.report.isEmpty {
                            Text(.init(String(model.report.prefix(9000))))
                                .font(.system(size: 14))
                                .textSelection(.enabled)
                            Button("Open full report") { model.openReport() }
                        }
                    case .activity:
                        Text("Activity")
                            .font(.system(size: 29, weight: .bold, design: .serif))
                        Text(model.phase)
                            .font(.system(size: 16, weight: .semibold))
                        if model.events.isEmpty { sheetInfo("Nothing running", "Verified tool activity and status appear here.") }
                        ForEach(Array(model.events.reversed().enumerated()), id: \.offset) { _, event in
                            Text(event)
                                .font(.system(size: 13, weight: .medium, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    case .help:
                        Text("Getting started")
                            .font(.system(size: 29, weight: .bold, design: .serif))
                        sheetInfo("01 · Open Lightroom", "Use your usual Lightroom Classic catalog. TonePilot does not create a second photo library.")
                        sheetInfo("02 · Select test photographs", "Select up to 20 photos in Lightroom.")
                        sheetInfo("03 · Read your selection", "Return to TonePilot and read the selected photo IDs. This verifies the live bridge.")
                        sheetInfo("04 · Run and review", "Choose your look and corrections. Review every AI adjustment in Lightroom Develop.")
                        sheetInfo("Bridge troubleshooting", "Lightroom → File → Plug-in Manager → Lightroom MCP → Start Server.")
                        Button("Open Lightroom Classic") { model.openLightroom() }
                    case .settings:
                        Text("Settings")
                            .font(.system(size: 29, weight: .bold, design: .serif))
                        sheetInfo("AI engine", model.codexReady ? "Codex is installed. Model access uses your existing Codex authentication." : "Codex was not detected. Install and authenticate Codex first.")
                        sheetInfo("Lightroom bridge", model.bridgeInstalled ? "Lightroom MCP is installed. Read a selection to verify a live connection." : "Lightroom MCP plug-in was not found.")
                        sheetInfo("Privacy", "The Codex cloud model may receive rendered previews and associated metadata. This prototype is not offline-only.")
                        Button("Refresh status") { model.refresh() }
                    }
                }
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Editorial.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(28)
            }
            .background(Editorial.paper)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Done") { model.panel = nil }
                        .foregroundStyle(Editorial.accent)
                }
            }
        }
    }

    private func sheetInfo(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 16, weight: .bold, design: .serif))
            Text(detail).font(.system(size: 14, weight: .medium)).foregroundStyle(Editorial.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Editorial.card, in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Editorial branding and illustration (small vector artwork, no second image viewer)
private struct TonePilotMonogram: View {
    var body: some View {
        ZStack {
            Circle().fill(Editorial.card)
            Circle().strokeBorder(Editorial.accent, lineWidth: 1.4)
            GeometryReader { g in
                HStack(spacing: 0) {
                    Color.clear
                    Editorial.accent.opacity(0.82)
                }
                .clipShape(Circle())
                Path { p in
                    let w=g.size.width, h=g.size.height
                    p.move(to: CGPoint(x:w*0.45,y:h*0.06))
                    p.addLine(to: CGPoint(x:w*0.45,y:h*0.94))
                    p.move(to: CGPoint(x:w*0.14,y:h*0.52))
                    p.addLine(to: CGPoint(x:w*0.45,y:h*0.52))
                    p.addLine(to: CGPoint(x:w*0.74,y:h*0.19))
                }
                .stroke(Editorial.ink.opacity(0.65), lineWidth: 1.3)
            }
            .padding(6)
        }
    }
}

private struct LookArtwork: View {
    let variant: Int
    var body: some View {
        GeometryReader { geo in
            Canvas { context, size in
                let skyTop: Color = variant == 0 ? Color(red:0.68,green:0.67,blue:0.64) :
                                    variant == 1 ? Color(red:0.84,green:0.72,blue:0.61) :
                                                   Color(red:0.47,green:0.56,blue:0.60)
                let skyBottom: Color = variant == 0 ? Color(red:0.92,green:0.79,blue:0.61) :
                                       variant == 1 ? Color(red:0.99,green:0.89,blue:0.69) :
                                                      Color(red:0.73,green:0.67,blue:0.55)
                context.fill(Path(CGRect(origin:.zero,size:size)),
                             with:.linearGradient(Gradient(colors:[skyTop,skyBottom]),
                                                  startPoint:.zero,endPoint:CGPoint(x:0,y:size.height)))
                let sunX = size.width * (variant == 0 ? 0.66 : variant == 1 ? 0.39 : 0.71)
                let sunY = size.height * (variant == 0 ? 0.32 : 0.24)
                let sunRect=CGRect(x:sunX-16,y:sunY-16,width:32,height:32)
                context.fill(Path(ellipseIn:sunRect),with:.color(Color.white.opacity(variant == 2 ? 0.25 : 0.50)))
                for layer in 0..<3 {
                    let y = size.height * (0.44 + Double(layer)*0.145)
                    var ridge=Path()
                    ridge.move(to:CGPoint(x:0,y:size.height))
                    ridge.addLine(to:CGPoint(x:0,y:y+12))
                    ridge.addLine(to:CGPoint(x:size.width*0.22,y:y-13 - Double(layer)*5))
                    ridge.addLine(to:CGPoint(x:size.width*0.38,y:y+9))
                    ridge.addLine(to:CGPoint(x:size.width*0.62,y:y-24 + Double(layer)*6))
                    ridge.addLine(to:CGPoint(x:size.width*0.83,y:y+3))
                    ridge.addLine(to:CGPoint(x:size.width,y:y-19))
                    ridge.addLine(to:CGPoint(x:size.width,y:size.height))
                    ridge.closeSubpath()
                    let c:Color = variant == 2 ? Color(red:0.14,green:0.21,blue:0.24) :
                                  Color(red:0.29,green:0.29,blue:0.24)
                    context.fill(ridge,with:.color(c.opacity(0.26 + Double(layer)*0.21)))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

private struct EditorialSideRail: View {
    let openReports: () -> Void
    let openHelp: () -> Void
    let openSettings: () -> Void
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment:.topLeading) {
                Editorial.dark
                DarkBotanicalArtwork()
                    .opacity(0.88)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
                    .allowsHitTesting(false)
                VStack(alignment:.leading,spacing:0) {
                    HStack {
                        Spacer()
                        Button(action:openSettings) {
                            Image(systemName:"gearshape")
                                .font(.system(size:17,weight:.semibold))
                                .frame(width:40,height:40)
                                .background(.white.opacity(0.07),in:Circle())
                        }
                        .buttonStyle(.plain)
                        .help("Setup and help")
                        Menu {
                            Button("Reports",action:openReports)
                            Button("Getting started",action:openHelp)
                        } label: {
                            Image(systemName:"ellipsis")
                                .font(.system(size:19,weight:.semibold))
                                .frame(width:40,height:40)
                                .background(.white.opacity(0.07),in:Circle())
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                    .foregroundStyle(Editorial.cream)
                    .padding(.top,26)
                    Rectangle()
                        .fill(Editorial.accentLight)
                        .frame(width:38,height:2)
                        .padding(.top,48)
                    Text("EDITORIAL STUDIO")
                        .font(.system(size:12,weight:.bold))
                        .tracking(2.6)
                        .foregroundStyle(Editorial.accentLight)
                        .padding(.top,22)
                    VStack(alignment: .leading, spacing: -8) {
                        Text("Refined")
                            .foregroundStyle(Editorial.cream)
                        HStack(spacing: 8) {
                            Text("starts").foregroundStyle(Editorial.cream)
                            Text("here.").italic().foregroundStyle(Editorial.accentLight)
                        }
                    }
                    .font(.system(size: 43, weight: .medium, design: .serif))
                    .tracking(-1.5)
                    Text("A thoughtful first pass.\nA more cohesive gallery.")
                        .font(.system(size:17,weight:.medium,design:.serif))
                        .foregroundStyle(Editorial.cream.opacity(0.88))
                        .lineSpacing(4)
                        .padding(.top,20)
                    Editorial.cream.opacity(0.22).frame(height:1).padding(.top,31).padding(.bottom,32)
                    railFeature("circle.hexagongrid", title:"Understand the light", subtitle:"Analyze color and exposure.")
                    railFeature("slider.horizontal.3", title:"Apply your direction", subtitle:"Make conservative corrections.")
                        .padding(.top,27)
                    railFeature("square.stack.3d.up", title:"Keep your creative eye", subtitle:"Review the results in Lightroom.")
                        .padding(.top,27)
                    Spacer(minLength:45)
                    Text("A MORE THOUGHTFUL\nEDITING EXPERIENCE")
                        .font(.system(size:11,weight:.semibold))
                        .tracking(2.0)
                        .foregroundStyle(Editorial.cream.opacity(0.74))
                        .lineSpacing(4)
                        .padding(.bottom,29)
                }
                .padding(.horizontal,27)
            }
        }
    }
    private func railFeature(_ icon:String,title:String,subtitle:String)->some View {
        HStack(alignment:.top,spacing:16) {
            Image(systemName:icon)
                .font(.system(size:24,weight:.ultraLight))
                .foregroundStyle(Editorial.accentLight)
                .frame(width:27)
            VStack(alignment:.leading,spacing:7) {
                Text(title)
                    .font(.system(size:17,weight:.semibold,design:.serif))
                    .foregroundStyle(Editorial.cream)
                    .fixedSize(horizontal:false,vertical:true)
                Text(subtitle)
                    .font(.system(size:12.5,weight:.medium))
                    .foregroundStyle(Editorial.softText)
                    .fixedSize(horizontal:false,vertical:true)
            }
        }
    }
}

// Matte vector botanical silhouette; decorative and GPU-light.
private struct DarkBotanicalArtwork: View {
    var body: some View {
        Canvas { ctx, size in
            let w=size.width,h=size.height
            var stem=Path()
            stem.move(to:CGPoint(x:w*1.08,y:h*1.04))
            stem.addCurve(to:CGPoint(x:w*0.63,y:h*0.54),
                          control1:CGPoint(x:w*0.45,y:h*0.88),
                          control2:CGPoint(x:w*0.86,y:h*0.73))
            ctx.stroke(stem,with:.color(Color(red:0.52,green:0.37,blue:0.27).opacity(0.45)),lineWidth:2)
            for i in 0..<13 {
                let t=Double(i)/13.0
                let x=w*(1.02-0.47*t)+sin(t*3.4)*w*0.11
                let y=h*(0.99-0.47*t)
                let right=i%2==0
                let dx=right ? 1.0 : -1.0
                var twig=Path()
                twig.move(to:CGPoint(x:x,y:y))
                twig.addQuadCurve(to:CGPoint(x:x+dx*w*0.21,y:y-h*0.105),
                                  control:CGPoint(x:x+dx*w*0.13,y:y-h*0.026))
                ctx.stroke(twig,with:.color(Color(red:0.55,green:0.40,blue:0.30).opacity(0.36)),lineWidth:1.2)
                for j in 0..<2 {
                    let xx=x+dx*w*(0.105+Double(j)*0.066)
                    let yy=y-h*(0.04+Double(j)*0.032)
                    var leaf=Path()
                    leaf.move(to:CGPoint(x:xx,y:yy))
                    leaf.addQuadCurve(to:CGPoint(x:xx+dx*w*0.075,y:yy-h*0.072),
                                     control:CGPoint(x:xx+dx*w*0.13,y:yy-h*0.01))
                    leaf.addQuadCurve(to:CGPoint(x:xx,y:yy),
                                     control:CGPoint(x:xx+dx*w*0.016,y:yy-h*0.099))
                    leaf.closeSubpath()
                    let opacity=0.12+Double(i%4)*0.035
                    ctx.fill(leaf,with:.color(Color(red:0.69,green:0.53,blue:0.39).opacity(opacity)))
                }
            }
        }
    }
}

private struct EditorialPrimaryButton: ButtonStyle {
    let enabled: Bool
    func makeBody(configuration:Configuration)->some View {
        configuration.label
            .foregroundStyle(enabled ? Color.white : Editorial.ink.opacity(0.72))
            .background(enabled ? Editorial.accent : Color(red:0.88,green:0.85,blue:0.81),
                        in:RoundedRectangle(cornerRadius:12))
            .scaleEffect(configuration.isPressed && enabled ? 0.991 : 1)
    }
}
