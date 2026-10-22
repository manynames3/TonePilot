import SwiftUI

// MARK: Setup

struct SetupView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Set up TonePilot").font(Theme.title)
                    Text("TonePilot works inside Lightroom Classic through a local plug-in and uses your AI service for assessment. Everything marked required must pass before a first pass.")
                        .font(Theme.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let doctor = model.doctor {
                    VStack(spacing: 0) {
                        ForEach(doctor.checks) { check in
                            CheckRow(check: check)
                            if check.id != doctor.checks.last?.id { Divider().padding(.leading, 44) }
                        }
                    }
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.separator.opacity(0.6), lineWidth: 0.5))
                    if doctor.ready {
                        Callout(tone: .verified, systemImage: "checkmark.seal.fill", title: "Ready",
                                message: "Lightroom, the plug-in and the AI service all answered. Select photos in Lightroom and start a first pass.")
                    }
                } else {
                    ProgressView("Checking…").frame(maxWidth: .infinity, minHeight: 120)
                }
                HStack(spacing: 10) {
                    Button { Task { await model.checkSetup() } } label: { Text("Check again").frame(minWidth: 110) }
                        .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
                    Button("Open Lightroom Classic") { model.openLightroom() }.controlSize(.large)
                    Button("Show Lightroom plug-in folder") { model.revealPluginFolder() }.controlSize(.large)
                    Spacer()
                    if model.ready { Button("Start a first pass") { model.route = .newPass }.controlSize(.large) }
                }
            }
            .padding(28).frame(maxWidth: 820, alignment: .leading)
        }
    }
}

private struct CheckRow: View {
    let check: Check
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: check.ok ? "checkmark.circle.fill" : check.required ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(check.ok ? Theme.verified : check.required ? Theme.danger : Theme.attention)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(check.title).font(Theme.bodyStrong)
                    if !check.required { Chip(text: "Recommended") }
                }
                if let detail = check.detail { Text(detail).font(Theme.secondary).foregroundStyle(.secondary).textSelection(.enabled) }
                if !check.ok, let fix = check.fix {
                    Text(fix).font(Theme.secondaryStrong).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(check.title): \(check.ok ? "passed" : "needs attention"). \(check.detail ?? "") \(check.ok ? "" : check.fix ?? "")")
    }
}

// MARK: New first pass

private let lookDescriptions: [String: String] = [
    "Natural": "Neutral skin, consistent subject exposure, highlights protected.",
    "Soft & airy": "Brighter subjects (+0.2 EV target), lifted shadows and blacks, softened highlights.",
    "True to scene": "Keeps the light and mood: smaller corrections are ignored and deliberate colour (candlelight, coloured stage light) is preserved."
]
private let strengthDescriptions: [String: String] = [
    "Subtle": "At most ±0.35 EV, ±12 mired white balance (≈ ±350 K in daylight), tint ±6, tone ±10–12. Applies 60% of each correction. Needs ≥ 88% model confidence.",
    "Balanced": "At most ±0.6 EV, ±20 mired white balance (≈ ±600 K in daylight), tint ±10, tone ±15–20. Applies 80% of each correction. Needs ≥ 82% model confidence.",
    "Stronger": "At most ±1.0 EV, ±30 mired white balance (≈ ±900 K in daylight), tint ±15, tone ±25–30. Applies the full correction. Needs ≥ 78% model confidence."
]

struct NewPassView: View {
    @EnvironmentObject var model: AppModel

    private var selection: SelectionReport? { model.selection }
    private var canAnalyze: Bool {
        guard let s = selection else { return false }
        return model.ready && !model.busy && !s.photos.isEmpty && !s.overLimit &&
            (model.fixWhiteBalance || model.fixExposure || model.fixTone)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("New first pass").font(Theme.title)
                    Text("Select photos in Lightroom Classic, choose a direction, and review TonePilot's proposed corrections before anything is written.")
                        .font(Theme.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if !model.attentionSessions.isEmpty {
                    Callout(tone: .attention, systemImage: "exclamationmark.triangle.fill", title: "A previous session needs your attention",
                            message: "Open it from the sidebar before starting new work on the same photos.")
                }
                if !model.ready {
                    Callout(tone: .danger, systemImage: "wrench.and.screwdriver.fill", title: "Setup is incomplete",
                            message: "Finish the required setup checks first.")
                }
                selectionCard
                directionCard
                correctionsCard
            }
            .padding(28).frame(maxWidth: 860, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom) { footer }
        .task { if model.selection == nil && model.ready { await model.readSelection() } }
    }

    private var selectionCard: some View {
        Card(title: "Lightroom selection", subtitle: "TonePilot only ever reads or edits the photos you authorize here.") {
            if let error = model.selectionError {
                Callout(tone: .danger, systemImage: "bolt.horizontal.circle", title: "Lightroom didn't answer", message: error)
            }
            if let s = selection {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(Format.plural(s.count, "photo")).font(.system(size: 22, weight: .semibold)).monospacedDigit()
                    Text("selected").font(Theme.body).foregroundStyle(.secondary)
                    Spacer()
                    ForEach(formatCounts(s), id: \.0) { Chip(text: "\($0.1) \($0.0)") }
                }
                if s.overLimit {
                    Callout(tone: .danger, systemImage: "rectangle.stack.badge.minus", title: "Too many photos for this version",
                            message: "TonePilot processes up to \(s.limit) photos per pass while larger galleries are being validated. Select fewer in Lightroom, then read the selection again.")
                } else if s.count == 0 {
                    Text("Nothing is selected. Select photos in Lightroom's Library grid or filmstrip.").font(Theme.secondary).foregroundStyle(.secondary)
                } else {
                    filenameList(s)
                    if s.photos.contains(where: { !$0.isRaw }) {
                        Text("White balance can't be changed on JPEG, HEIC or TIFF files through the Lightroom bridge; those photos get exposure and tone corrections only.")
                            .font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Text("If nothing is selected, Lightroom reports every photo in the filmstrip. Check that these are the photos you meant.")
                        .font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else if model.selectionError == nil {
                Text("Select photos in Lightroom, then read the selection.").font(Theme.body).foregroundStyle(.secondary)
            }
            Button { Task { await model.readSelection() } } label: {
                Label(selection == nil ? "Read Lightroom selection" : "Read selection again", systemImage: "arrow.clockwise")
            }
            .disabled(model.busy || !model.ready)
            .keyboardShortcut("r", modifiers: .command)
        }
    }

    private func filenameList(_ s: SelectionReport) -> some View {
        let shown = s.photos.prefix(6)
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(shown) { p in
                HStack {
                    Text(p.filename).font(Theme.value)
                    Spacer()
                    if let t = p.captureTime { Text(t).font(Theme.secondary).foregroundStyle(.secondary) }
                }
            }
            if s.photos.count > shown.count {
                Text("and \(s.photos.count - shown.count) more").font(Theme.secondary).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
    }

    private func formatCounts(_ s: SelectionReport) -> [(String, Int)] {
        Dictionary(grouping: s.photos, by: \.format).map { ($0.key.isEmpty ? "?" : $0.key, $0.value.count) }.sorted { $0.1 > $1.1 }
    }

    private var directionCard: some View {
        Card(title: "Editing direction", subtitle: "Each choice changes enforced limits and targets, not just wording.") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Look").font(Theme.secondaryStrong).foregroundStyle(.secondary)
                Picker("Look", selection: $model.look) {
                    Text("Natural").tag("Natural"); Text("Soft & airy").tag("Soft & airy"); Text("True to scene").tag("True to scene")
                }
                .pickerStyle(.segmented).labelsHidden().controlSize(.large)
                Text(lookDescriptions[model.look] ?? "").font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("Every look leaves deliberate low-key, high-key and silhouette frames alone.").font(Theme.secondary).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Strength").font(Theme.secondaryStrong).foregroundStyle(.secondary)
                Picker("Strength", selection: $model.strength) {
                    Text("Subtle").tag("Subtle"); Text("Balanced").tag("Balanced"); Text("Stronger").tag("Stronger")
                }
                .pickerStyle(.segmented).labelsHidden().controlSize(.large)
                Text(strengthDescriptions[model.strength] ?? "").font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("Limits are cumulative: running TonePilot again on the same photos can't push them further than one pass would.")
                    .font(Theme.secondary).foregroundStyle(.secondary)
            }
        }
        .disabled(model.busy)
    }

    private var correctionsCard: some View {
        Card(title: "What TonePilot may change") {
            CorrectionToggle(title: "White balance and tint", detail: "Temperature and Tint on RAW files: casts, and drift between frames in the same light.", isOn: $model.fixWhiteBalance)
            Divider()
            CorrectionToggle(title: "Exposure", detail: "Subject brightness, matched across frames of the same scene; highlights are protected.", isOn: $model.fixExposure)
            Divider()
            CorrectionToggle(title: "Highlights, shadows, whites and blacks", detail: "Recover detail without flattening the light.", isOn: $model.fixTone)
            Text("Never touched: crop, masks, profiles, HSL, presets, metadata, ratings, export.").font(Theme.secondary).foregroundStyle(.secondary)
        }
        .disabled(model.busy)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Analysis only reads Lightroom.").font(Theme.secondaryStrong)
                    Text("640-px previews are sent to your Codex AI account for assessment; measurements run on this Mac.")
                        .font(Theme.secondary).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await model.analyze() } } label: {
                    Text(selection.map { $0.count > 0 && !$0.overLimit ? "Analyze \(Format.plural($0.count, "photo"))" : "Analyze" } ?? "Analyze")
                        .font(Theme.bodyStrong).frame(minWidth: 170)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!canAnalyze)
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(.horizontal, 28).padding(.vertical, 14)
        }
        .background(.bar)
    }
}

private struct CorrectionToggle: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Theme.bodyStrong)
                Text(detail).font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
    }
}
