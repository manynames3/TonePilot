import SwiftUI

// MARK: Setup

struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var showPassed = Disclosure()

    // Problems first; once everything passes, the green list folds away.
    private func visible(_ doctor: DoctorReport) -> [Check] {
        let failing = doctor.checks.filter { !$0.ok }, passed = doctor.checks.filter(\.ok)
        return doctor.ready && !showPassed.open ? failing : failing + passed
    }

    var body: some View {
        Page {
            SectionLabel(step: nil, title: "Setup")
            Text("Connect TonePilot to Lightroom").font(Theme.display).tracking(-1.4).padding(.top, 10)
            Text("TonePilot works inside Lightroom Classic through a local plug-in and uses your AI service for assessment. Everything required must pass before your first pass.")
                .font(Theme.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
            if let doctor = model.doctor {
                if doctor.ready {
                    Callout(tone: .verified, systemImage: "checkmark.seal.fill", title: "Ready for a first pass",
                            message: "All \(doctor.checks.filter { $0.required }.count) required checks passed: Lightroom, the plug-in and your AI service all answered. Select photos in Lightroom to begin.")
                        .padding(.top, 24)
                }
                let rows = visible(doctor)
                if !rows.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(rows) { check in
                            CheckRow(check: check)
                            if check.id != rows.last?.id { Rule().padding(.leading, 52) }
                        }
                    }
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 0.7))
                    .padding(.top, doctor.ready ? 14 : 24)
                }
                if doctor.ready {
                    Button(showPassed.open ? "Hide passed checks" : "Show all \(doctor.checks.count) checks") { showPassed.open.toggle() }
                        .buttonStyle(QuietButtonStyle()).padding(.top, 12)
                }
            } else {
                HStack(spacing: 12) { ProgressView().controlSize(.small); Text("Checking Lightroom, the plug-in and the AI service…").font(Theme.body).foregroundStyle(Theme.muted) }
                    .padding(.top, 28)
            }
            HStack(spacing: 12) {
                if model.ready {
                    Button { model.route = .newPass } label: { Label("Start a first pass", systemImage: "arrow.right") }
                        .buttonStyle(PrimaryButtonStyle()).labelStyle(TrailingIconLabelStyle())
                    Button("Check again") { Task { await model.checkSetup() } }.buttonStyle(SecondaryButtonStyle()).disabled(model.busy)
                } else {
                    Button("Check again") { Task { await model.checkSetup() } }.buttonStyle(PrimaryButtonStyle()).disabled(model.busy)
                    Button("Open Lightroom Classic") { model.openLightroom() }.buttonStyle(SecondaryButtonStyle())
                    Button("Show plug-in folder") { model.revealPluginFolder() }.buttonStyle(SecondaryButtonStyle())
                }
                Spacer()
            }
            .padding(.top, 22)
            Rule().padding(.top, 32).padding(.bottom, 26)
            AIServiceSection(ai: model.ai)
        }
    }
}

// MARK: AI service

private struct AIServiceSection: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var ai: AIServiceSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(step: nil, title: "AI service", trailing: "Assesses your previews")
            Text("Only small previews leave this Mac. The service suggests; TonePilot checks and makes every edit.")
                .font(Theme.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                ForEach(AIProvider.choices) { p in
                    ProviderTile(provider: p, selected: ai.provider == p) { ai.provider = p; ai.newKey = "" }
                }
            }
            .padding(.top, 4)
            if ai.provider.isClaude { claudeSettings }
            if ai.saveFailed {
                Callout(tone: .danger, systemImage: "key.slash", title: "The key wasn't saved",
                        message: "The macOS Keychain refused it. Try again, or check Keychain Access.")
            }
            HStack(spacing: 14) {
                Button("Save and check again") { ai.save(); Task { await model.checkSetup() } }
                    .buttonStyle(SecondaryButtonStyle()).disabled(model.busy || !ai.dirty)
                if ai.dirty { Button("Discard changes") { ai.load() }.buttonStyle(QuietButtonStyle()) }
                Spacer()
            }
            .padding(.top, 4)
        }
        .disabled(model.busy)
    }

    private var claudeSettings: some View {
        PaperCard(padding: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Model").font(Theme.secondaryStrong)
                HStack(spacing: 8) {
                    ForEach(AIModel.choices(ai.provider)) { m in ModelChip(model: m, selected: ai.model == m) { ai.model = m } }
                }
            }
            if ai.provider == .bedrock {
                HStack(alignment: .top, spacing: 12) {
                    Field(label: "AWS region") { TextField("us-east-1", text: $ai.region) }
                    Field(label: "AWS profile · optional") { TextField("default", text: $ai.profile) }
                }
                .padding(.top, 4)
            }
            keyField.padding(.top, ai.provider == .bedrock ? 0 : 4)
            Label { Text(keyNote).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "lock") }
                .font(Theme.secondary).foregroundStyle(Theme.muted).padding(.top, 2)
        }
        .padding(.top, 2)
    }

    private var keyField: some View {
        let bedrock = ai.provider == .bedrock
        return Field(label: bedrock ? "Bedrock API key · optional" : "API key",
                     action: ai.keyHint == nil ? nil : ("Remove saved key", { ai.removeKey(); Task { await model.checkSetup() } })) {
            SecureField(ai.keyHint.map { "Saved  \($0)" } ?? (bedrock ? "Paste a Bedrock API key" : "Paste your key (sk-ant-…)"), text: $ai.newKey)
        }
    }

    private var keyNote: String {
        ai.provider == .bedrock
            ? "Without a key, TonePilot uses your AWS sign-in (aws configure or aws sso login). Keys stay in your Mac's Keychain."
            : "Create a key at console.anthropic.com. It stays in your Mac's Keychain, never in a file."
    }
}

private struct ProviderTile: View {
    let provider: AIProvider; let selected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(provider.name).font(Theme.serif(17))
                    Spacer(minLength: 6)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 17, weight: .medium)).foregroundStyle(selected ? Theme.accent : Theme.neutral.opacity(0.45))
                }
                Text(provider.tagline).font(.system(size: 11.5, weight: .bold)).tracking(1.0).foregroundStyle(Theme.accent)
                Text(provider.detail).font(Theme.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).padding(.top, 2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 13)
            .frame(maxWidth: .infinity, minHeight: 108, alignment: .topLeading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Theme.accent : Theme.line, lineWidth: selected ? 2.2 : 0.8))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(provider.name). \(provider.detail)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct ModelChip: View {
    let model: AIModel; let selected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(model.name).font(.system(size: 14, weight: selected ? .bold : .medium))
                if model == .opus {
                    Text("DEFAULT").font(.system(size: 10.5, weight: .bold)).tracking(1.0)
                        .foregroundStyle(selected ? Color.white.opacity(0.8) : Theme.muted)
                }
            }
            .foregroundStyle(selected ? Color.white : Theme.ink)
            .padding(.horizontal, 14).frame(height: 34)
            .background(selected ? Theme.accent : Theme.sunken, in: RoundedRectangle(cornerRadius: 9))
            .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model \(model.name)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

// A labelled text input in the paper style.
private struct Field<Input: View>: View {
    let label: String
    var action: (String, () -> Void)? = nil
    @ViewBuilder var input: Input
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(Theme.secondaryStrong)
                Spacer()
                if let action { Button(action.0, action: action.1).buttonStyle(QuietButtonStyle()) }
            }
            input.textFieldStyle(.plain).font(Theme.value)
                .padding(.horizontal, 12).frame(height: 36)
                .background(Theme.paper, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Theme.line, lineWidth: 0.8))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CheckRow: View {
    let check: Check
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: check.ok ? "checkmark.circle.fill" : check.required ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(check.ok ? Theme.verified : check.required ? Theme.danger : Theme.attention)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 10) {
                    Text(check.title).font(Theme.serif(16))
                    if !check.required { Text("RECOMMENDED").font(.system(size: 11, weight: .bold)).tracking(1.2).foregroundStyle(Theme.muted) }
                }
                if let detail = check.detail { Text(detail).font(Theme.secondary).foregroundStyle(Theme.muted).textSelection(.enabled) }
                if !check.ok, let fix = check.fix {
                    Text(fix).font(Theme.secondaryStrong).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(check.title): \(check.ok ? "passed" : "needs attention"). \(check.detail ?? "") \(check.ok ? "" : check.fix ?? "")")
    }
}

// MARK: New first pass

private struct LookOption { let value: String; let name: String; let tagline: String; let detail: String; let ramp: [Color] }
private let looks = [
    LookOption(value: "Natural", name: "Natural", tagline: "TRUE TO LIFE", detail: "Neutral skin, consistent exposure, protected highlights.",
               ramp: [Color(red: 0.30, green: 0.28, blue: 0.26), Color(red: 0.62, green: 0.58, blue: 0.53), Color(red: 0.93, green: 0.90, blue: 0.85)]),
    LookOption(value: "Soft & airy", name: "Soft & airy", tagline: "GENTLE LIGHT", detail: "Subjects +0.2 EV brighter, lifted shadows and blacks.",
               ramp: [Color(red: 0.55, green: 0.51, blue: 0.47), Color(red: 0.82, green: 0.78, blue: 0.72), Color(red: 0.99, green: 0.96, blue: 0.92)]),
    LookOption(value: "True to scene", name: "True to scene", tagline: "KEEP ATMOSPHERE", detail: "Ignores small corrections; keeps deliberate colour.",
               ramp: [Color(red: 0.16, green: 0.15, blue: 0.15), Color(red: 0.49, green: 0.43, blue: 0.37), Color(red: 0.86, green: 0.77, blue: 0.62)])
]
private let strengthLimits: [String: (String, String)] = [
    "Subtle": ("Up to ±0.35 EV · ±12 mired white balance (≈ ±350 K in daylight) · tone ±10–12",
               "Applies 60% of each correction · needs ≥ 88% model confidence"),
    "Balanced": ("Up to ±0.6 EV · ±20 mired white balance (≈ ±600 K in daylight) · tone ±15–20",
                 "Applies 80% of each correction · needs ≥ 82% model confidence"),
    "Stronger": ("Up to ±1.0 EV · ±30 mired white balance (≈ ±900 K in daylight) · tone ±25–30",
                 "Applies the full correction · needs ≥ 78% model confidence")
]

struct NewPassView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var showAll = Disclosure()

    private var selection: SelectionReport? { model.selection }
    private var enabledCount: Int { [model.fixWhiteBalance, model.fixExposure, model.fixTone].filter { $0 }.count }

    var body: some View {
        VStack(spacing: 0) {
            Page {
                if !model.attentionSessions.isEmpty {
                    Callout(tone: .attention, systemImage: "exclamationmark.triangle.fill", title: "A session needs your attention",
                            message: "Open it from the sidebar and settle it before starting new work on the same photos.")
                        .padding(.bottom, 24)
                }
                selectionSection
                Rule().padding(.vertical, 24)
                lookSection
                Rule().padding(.vertical, 24)
                strengthSection
                Rule().padding(.vertical, 24)
                correctionsSection
            }
            bottomBar
        }
        .task { if model.selection == nil && model.ready { await model.readSelection() } }
    }

    // MARK: Step 1

    private var headline: String {
        guard let s = selection else { return "Choose your photos" }
        if s.count == 0 { return "Choose your photos" }
        return Format.plural(s.count, "photo") + " selected"
    }

    private var selectionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(step: "STEP 1", title: "Your selection", trailing: selection.map { formatSummary($0) })
            Text(headline).font(Theme.display).tracking(-1.4).lineLimit(1).minimumScaleFactor(0.8)
            Text(selection?.count ?? 0 > 0 ? "TonePilot only ever reads or edits the photos listed here."
                 : "Select up to 20 photos in Lightroom's Library grid or filmstrip, then read your selection.")
                .font(Theme.body).foregroundStyle(Theme.muted)
            HStack(spacing: 14) {
                Image(systemName: (selection?.count ?? 0) > 0 ? "square.stack.3d.up" : "photo.on.rectangle.angled")
                    .font(.system(size: 22)).foregroundStyle(Theme.ink).frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Lightroom selection").font(Theme.serif(16))
                    Text(selectionDetail).font(Theme.secondary).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 8)
                Button { Task { await model.readSelection() } } label: {
                    Label(selection == nil ? "Read selection" : "Update selection", systemImage: "arrow.clockwise")
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(model.busy || !model.ready)
                .keyboardShortcut("r", modifiers: .command)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 6)
            if let error = model.selectionError {
                Callout(tone: .danger, systemImage: "bolt.horizontal.circle", title: "Lightroom didn't answer", message: error)
            }
            if let s = selection, s.count > 0 {
                if s.overLimit {
                    Callout(tone: .danger, systemImage: "rectangle.stack.badge.minus", title: "Too many photos for this version",
                            message: "TonePilot processes up to \(s.limit) photos per pass while larger galleries are being validated. Select fewer in Lightroom, then update the selection.")
                } else {
                    filenames(s)
                }
                if s.photos.contains(where: { !$0.isRaw }) {
                    Note(icon: "info.circle", text: "White balance can't be changed on JPEG, HEIC or TIFF files through the Lightroom bridge. Those photos get exposure and tone corrections only.")
                }
                Note(icon: "rectangle.on.rectangle", text: "If nothing is selected, Lightroom reports every photo in the filmstrip. Check these are the photos you meant.")
            }
        }
    }

    private var selectionDetail: String {
        guard let s = selection else { return model.ready ? "Not read yet" : "Finish setup first" }
        if s.count == 0 { return "Nothing selected in Lightroom" }
        let names = s.photos.prefix(2).map(\.filename).joined(separator: " · ")
        return s.photos.count > 2 ? names + "  +\(s.photos.count - 2)" : names
    }

    private func filenames(_ s: SelectionReport) -> some View {
        let shown = showAll.open ? Array(s.photos) : Array(s.photos.prefix(4))
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(shown) { p in
                HStack {
                    Text(p.filename).font(Theme.value).foregroundStyle(Theme.ink)
                    Spacer()
                    if let t = p.captureTime { Text(t).font(Theme.secondary).monospacedDigit().foregroundStyle(Theme.muted) }
                }
                .padding(.vertical, 5)
                if p.id != shown.last?.id { Rule() }
            }
            if s.photos.count > 4 {
                Button(showAll.open ? "Show fewer" : "Show all \(s.photos.count) photos") { showAll.open.toggle() }
                    .buttonStyle(QuietButtonStyle()).padding(.top, 8)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 0.7))
    }

    private func formatSummary(_ s: SelectionReport) -> String {
        Dictionary(grouping: s.photos, by: \.format).map { "\($0.value.count) \($0.key.isEmpty ? "?" : $0.key)" }.sorted().joined(separator: " · ")
    }

    // MARK: Steps 2–4

    private var lookSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(step: "STEP 2", title: "Choose a look", trailing: "Your direction")
            HStack(spacing: 12) {
                ForEach(looks, id: \.value) { look in
                    LookTile(look: look, selected: model.look == look.value) { model.look = look.value }
                }
            }
            Note(icon: "moon.stars", text: "Every look leaves deliberate low-key, high-key and silhouette frames alone.")
        }
        .disabled(model.busy)
    }

    private var strengthSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                SectionLabel(step: "STEP 3", title: "Adjust strength")
                Text(model.strength).font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 12).frame(height: 27).background(Theme.accent, in: RoundedRectangle(cornerRadius: 7))
            }
            StrengthStops(value: $model.strength)
            let limits = strengthLimits[model.strength] ?? ("", "")
            VStack(alignment: .leading, spacing: 4) {
                Text(limits.0).font(Theme.secondaryStrong).foregroundStyle(Theme.ink)
                Text(limits.1 + " · limits are cumulative across runs").font(Theme.secondary).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 12))
        }
        .disabled(model.busy)
    }

    private var correctionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(step: "STEP 4", title: "What to correct", trailing: "\(enabledCount) of 3 enabled")
            CorrectionRow(icon: "circle.lefthalf.filled", title: "White balance & skin", detail: "Temperature and tint on RAW files: casts, and drift between frames in the same light.", isOn: $model.fixWhiteBalance)
            CorrectionRow(icon: "sun.max", title: "Exposure", detail: "Subject brightness, matched across frames of the same scene; highlights protected.", isOn: $model.fixExposure)
            CorrectionRow(icon: "circle.dotted.circle", title: "Highlights & shadows", detail: "Recover detail while preserving depth.", isOn: $model.fixTone)
            Note(icon: "lock", text: "Never touched: crop, masks, profiles, HSL, presets, metadata, ratings or export.")
        }
        .disabled(model.busy)
    }

    // MARK: Primary action

    private enum Next { case setup, read, analyze, blocked(String) }
    private var next: Next {
        if !model.ready { return .setup }
        guard let s = selection, s.count > 0 else { return .read }
        if s.overLimit { return .blocked("Select 20 photos or fewer") }
        if enabledCount == 0 { return .blocked("Enable at least one correction") }
        return .analyze
    }

    private var bottomBar: some View {
        VStack(spacing: 9) {
            Button {
                switch next {
                case .setup: model.route = .setup
                case .read: Task { await model.readSelection() }
                case .analyze: Task { await model.analyze() }
                case .blocked: break
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 16, weight: .semibold))
                    Text(primaryTitle).lineLimit(1)
                    Spacer(minLength: 0)
                    if case .blocked = next {} else { Image(systemName: "arrow.right").font(.system(size: 15, weight: .bold)) }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(model.busy || { if case .blocked = next { return true }; return false }())
            .keyboardShortcut(.return, modifiers: .command)
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                Text("Analysis only reads Lightroom · 640-px previews go to \(model.ai.active.destination) · measurements stay on this Mac")
            }
            .font(Theme.secondary).foregroundStyle(Theme.muted).lineLimit(1).minimumScaleFactor(0.85)
        }
        .padding(.horizontal, 40).padding(.top, 14).padding(.bottom, 16)
        .background(Theme.paper)
        .overlay(alignment: .top) { Rule() }
    }

    private var primaryTitle: String {
        switch next {
        case .setup: return "Finish setup to continue"
        case .read: return selection == nil ? "Read Lightroom selection" : "Update Lightroom selection"
        case .analyze: return "Analyze \(Format.plural(selection?.count ?? 0, "photo")) · no edits yet"
        case .blocked(let why): return why
        }
    }
}

private struct Note: View {
    let icon: String; let text: String
    var body: some View {
        Label { Text(text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: icon) }
            .font(Theme.secondary).foregroundStyle(Theme.muted)
    }
}

private struct LookTile: View {
    let look: LookOption; let selected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .topTrailing) {
                    // A tonal ramp of the look, not a photograph: shadows → highlights.
                    LinearGradient(colors: look.ramp, startPoint: .leading, endPoint: .trailing).frame(height: 44)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, selected ? Theme.accent : .white.opacity(0.15))
                        .font(.system(size: 19, weight: .medium)).padding(9)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(look.name).font(Theme.serif(18))
                    Text(look.tagline).font(.system(size: 11.5, weight: .bold)).tracking(1.0).foregroundStyle(Theme.accent)
                    Text(look.detail).font(Theme.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                        .lineLimit(3).padding(.top, 2)
                }
                .padding(.horizontal, 13).padding(.top, 11).padding(.bottom, 13)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 148, alignment: .topLeading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Theme.accent : Theme.line, lineWidth: selected ? 2.2 : 0.8))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(look.name). \(look.detail)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct StrengthStops: View {
    @Binding var value: String
    private let stops = ["Subtle", "Balanced", "Stronger"]
    var body: some View {
        HStack(spacing: 0) {
            ForEach(stops, id: \.self) { stop in
                let active = value == stop
                Button { value = stop } label: {
                    VStack(spacing: 10) {
                        ZStack {
                            Theme.line.frame(height: 4)
                            Circle().fill(active ? Theme.accent : Color(red: 0.76, green: 0.72, blue: 0.69))
                                .frame(width: active ? 22 : 15, height: active ? 22 : 15)
                                .overlay(Circle().stroke(Theme.paper, lineWidth: active ? 3 : 1.5))
                        }
                        Text(stop).font(.system(size: 14, weight: active ? .bold : .medium)).foregroundStyle(active ? Theme.ink : Theme.muted)
                    }
                    .frame(maxWidth: .infinity).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Strength \(stop)")
                .accessibilityAddTraits(active ? [.isSelected] : [])
            }
        }
    }
}

private struct CorrectionRow: View {
    let icon: String; let title: String; let detail: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 21)).foregroundStyle(Theme.accent).frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(Theme.serif(16))
                    Text(detail).font(Theme.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .toggleStyle(CapsuleToggleStyle())
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 0.7))
        .accessibilityLabel(title)
    }
}
