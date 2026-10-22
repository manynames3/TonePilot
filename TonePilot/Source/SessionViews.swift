import SwiftUI

// Review, apply, verify and restore one session. Lightroom stays the place to LOOK at
// photos; this screen explains what TonePilot intends, did, verified and can undo.
struct SessionDetailView: View {
    @EnvironmentObject var model: AppModel
    let session: SessionView
    // View-local state lives in a StateObject: the Command Line Tools SDK lacks the
    // SwiftUI macro plugin that @State now requires.
    @StateObject private var ui = SessionUIState()

    private var approved: Set<String> { model.approvals[session.id] ?? [] }
    private var approvedApplicable: [PhotoView] { session.photos.filter { $0.isApplicable && approved.contains($0.id) } }
    private var review: [PhotoView] { session.photos.filter(\.needsReview) }
    // A warning every analyzed photo shares (e.g. "white balance not adjustable for HEIC")
    // is said once in the header instead of on every card.
    private var commonWarnings: Set<String> {
        let analyzed = session.photos.filter { $0.state != "unsupported" }
        guard analyzed.count > 1, let first = analyzed.first else { return [] }
        return Set(first.warnings.filter { w in analyzed.allSatisfy { $0.warnings.contains(w) } })
    }

    var body: some View {
        VStack(spacing: 0) {
            Page(maxWidth: 900) {
                header
                ForEach(Array(session.scenes.enumerated()), id: \.element.id) { index, scene in
                    sceneSection(scene, index: index + 1)
                }
                let loose = session.photos.filter { $0.scene == nil }
                if !loose.isEmpty {
                    SectionLabel(step: nil, title: "Not analyzed", trailing: Format.plural(loose.count, "photo")).padding(.top, 28).padding(.bottom, 10)
                    VStack(spacing: 10) { ForEach(loose) { PhotoCard(photo: $0, session: session, isReference: false, hidden: commonWarnings) } }
                }
            }
            actionBar
        }
        .modifier(Confirmations(model: model, session: session, ui: ui, approvedCount: approvedApplicable.count))
    }

    private func sceneSection(_ scene: SceneInfo, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(step: "SCENE \(index)", title: Format.plural(scene.photos.count, "photo"),
                         trailing: scene.flash.map { $0 ? "Flash" : "Ambient light" })
            if index > 1, let reasons = scene.startedBecause, !reasons.isEmpty {
                Text("New lighting scene: " + reasons.joined(separator: ", ")).font(Theme.secondary).foregroundStyle(Theme.muted)
            }
            VStack(spacing: 10) {
                ForEach(scene.photos.compactMap { id in session.photos.first { $0.id == id } }) { photo in
                    PhotoCard(photo: photo, session: session, isReference: scene.reference == photo.id, hidden: commonWarnings)
                }
            }
        }
        .padding(.top, 30)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(step: nil, title: "First pass", trailing: [session.look, session.strength].compactMap { $0 }.joined(separator: " · "))
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Text(Format.date(session.created)).font(Theme.display).tracking(-1.4).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                StatusPill(label: session.running.map { _ in "Working…" } ?? session.label, tone: sessionTone(session.status))
            }
            Text(session.explanation).font(Theme.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 0) {
                Metric(value: session.count("proposed") + session.count("apply-failed"), label: "To apply", tone: .accent)
                Metric(value: session.present, label: "In Lightroom", tone: .verified)
                Metric(value: session.restored, label: "Restored", tone: .neutral)
                Metric(value: session.count("skipped"), label: "Unchanged", tone: .neutral)
                Metric(value: review.count, label: "Need review", tone: review.isEmpty ? .neutral : .attention)
            }
            .padding(.vertical, 14).padding(.horizontal, 6)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 0.7))
            .padding(.top, 8)
            attentionCallout
            ForEach(Array(commonWarnings).sorted(), id: \.self) { w in
                Label(w, systemImage: "info.circle").font(Theme.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let error = session.analysisError ?? session.errors.last?.message {
                Label("Last problem: " + error, systemImage: "exclamationmark.bubble").font(Theme.secondary).foregroundStyle(Theme.muted).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private var attentionCallout: some View {
        switch session.status {
        case "interrupted":
            Callout(tone: .danger, systemImage: "bolt.trianglebadge.exclamationmark.fill", title: "A Lightroom write was in flight when TonePilot stopped",
                    message: "TonePilot doesn't know yet whether \(Format.plural(session.unresolved.count, "photo")) changed. Check Lightroom to settle it from the actual values before doing anything else.")
        case "partially-restored":
            Callout(tone: .attention, systemImage: "arrow.uturn.backward.circle", title: "Some TonePilot changes are still in Lightroom",
                    message: "Photos you edited after TonePilot were not restored, so your later work is safe. Restore them by hand or with Lightroom's History panel.")
        case "damaged":
            Callout(tone: .danger, systemImage: "doc.badge.ellipsis", title: "This session record is damaged",
                    message: "TonePilot won't write to these photos. Check each one in Lightroom's History panel; TonePilot's steps are labelled “Set Develop Settings”.")
        case "analysis-incomplete", "analysis-failed":
            Callout(tone: .attention, systemImage: "pause.circle", title: "The analysis didn't finish",
                    message: "Nothing was written to Lightroom. Resume to analyze the remaining photos, or discard this plan.")
        default:
            if session.photos.contains(where: { $0.state == "apply-mismatch" }) {
                Callout(tone: .attention, systemImage: "exclamationmark.triangle.fill", title: "Some photos read back differently than planned",
                        message: "Lightroom stored a slightly different value or another setting changed at the same moment. Check the flagged photos.")
            }
        }
    }

    // MARK: Actions

    private var actionBar: some View {
        HStack(spacing: 14) {
            if !review.isEmpty {
                Button { model.copyFilenames(review) } label: { Label("Copy \(Format.plural(review.count, "filename"))", systemImage: "doc.on.doc") }
                    .buttonStyle(QuietButtonStyle(color: Theme.ink))
                    .help("Paste into Lightroom's Library Filter text search to see the photos that need review")
            }
            Button { model.revealSession(session) } label: { Label("Report", systemImage: "doc.text") }
                .buttonStyle(QuietButtonStyle(color: Theme.ink))
            Spacer()
            if session.actions.discard && session.status != "restored" && session.status != "discarded" {
                Button("Discard plan") { ui.confirmDiscard = true }.buttonStyle(SecondaryButtonStyle())
            }
            if session.actions.restore {
                Button("Restore originals") { ui.confirmRestore = true }.buttonStyle(SecondaryButtonStyle())
            }
            primary
        }
        .padding(.horizontal, 40).padding(.vertical, 14)
        .background(Theme.paper)
        .overlay(alignment: .top) { Rule() }
        .disabled(model.busy || session.running != nil)
    }

    @ViewBuilder private var primary: some View {
        if session.actions.reconcile {
            Button { Task { await model.reconcile(session) } } label: { Label("Check Lightroom now", systemImage: "arrow.right") }
                .buttonStyle(PrimaryButtonStyle()).labelStyle(TrailingIconLabelStyle()).keyboardShortcut(.return, modifiers: .command)
        } else if session.actions.resumeAnalysis {
            Button { Task { await model.resumeAnalysis(session) } } label: { Label("Resume analysis", systemImage: "arrow.right") }
                .buttonStyle(PrimaryButtonStyle()).labelStyle(TrailingIconLabelStyle()).keyboardShortcut(.return, modifiers: .command)
        } else if session.actions.apply {
            Menu {
                Button("Approve all \(session.candidates)") { model.setAllApprovals(true, in: session) }
                Button("Approve none") { model.setAllApprovals(false, in: session) }
            } label: {
                Text("\(approvedApplicable.count) of \(session.candidates) approved").font(Theme.secondaryStrong).foregroundStyle(Theme.ink)
            }
            .menuStyle(.borderlessButton).fixedSize()
            Button { ui.confirmApply = true } label: {
                Label(approvedApplicable.isEmpty ? "Approve edits to apply" : "Apply \(Format.plural(approvedApplicable.count, "edit"))", systemImage: "arrow.right")
            }
            .buttonStyle(PrimaryButtonStyle()).labelStyle(TrailingIconLabelStyle())
            .disabled(approvedApplicable.isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
        }
    }
}

final class SessionUIState: ObservableObject {
    @Published var confirmApply = false
    @Published var confirmRestore = false
    @Published var confirmDiscard = false
}

final class Disclosure: ObservableObject { @Published var open = false }

private struct Confirmations: ViewModifier {
    @ObservedObject var model: AppModel
    let session: SessionView
    @ObservedObject var ui: SessionUIState
    let approvedCount: Int
    func body(content: Content) -> some View {
        content
            .confirmationDialog("Apply \(Format.plural(approvedCount, "edit")) in Lightroom?", isPresented: $ui.confirmApply) {
                Button("Apply \(Format.plural(approvedCount, "edit"))") { Task { await model.apply(session) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Before each write TonePilot confirms the photo and its current settings. Photos you've edited since analysis are skipped. Every value is read back afterwards, and you can restore the originals from this session.")
            }
            .confirmationDialog("Restore original settings?", isPresented: $ui.confirmRestore) {
                Button("Restore \(Format.plural(session.present, "photo"))") { Task { await model.restore(session) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Only the values TonePilot wrote are restored, and only on photos you haven't changed since. Your later edits are kept.")
            }
            .confirmationDialog("Discard this plan?", isPresented: $ui.confirmDiscard) {
                Button("Discard plan", role: .destructive) { Task { await model.discard(session) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Nothing in Lightroom changes. The record is kept but hidden from your active work.") }
    }
}

private struct Metric: View {
    let value: Int; let label: String; let tone: Tone
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)").font(Theme.serif(28, .bold)).monospacedDigit()
                .foregroundStyle(value == 0 ? Theme.neutral.opacity(0.7) : tone == .neutral ? Theme.ink : tone.color)
            Text(label.uppercased()).font(.system(size: 11.5, weight: .bold)).tracking(1.1).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Photo card

struct PhotoCard: View {
    @EnvironmentObject var model: AppModel
    let photo: PhotoView
    let session: SessionView
    let isReference: Bool
    var hidden: Set<String> = []
    @StateObject private var disclosure = Disclosure()

    private var approvable: Bool { photo.isApplicable && session.actions.apply }
    private var isApproved: Bool { (model.approvals[session.id] ?? []).contains(photo.id) }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            if approvable {
                Toggle("Approve edit for \(photo.filename)", isOn: Binding(get: { isApproved }, set: { _ in model.toggleApproval(photo, in: session) }))
                    .toggleStyle(CheckboxStyle()).padding(.top, 3)
            }
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Text(photo.filename).font(Theme.serif(17)).textSelection(.enabled)
                    if !photo.format.isEmpty { Chip(text: photo.format) }
                    if isReference { Chip(text: "Scene reference", systemImage: "scope") }
                    Spacer(minLength: 8)
                    StatusPill(label: photo.stateLabel, tone: photoTone(photo.state))
                }
                if !photo.changes.isEmpty { ChangeTable(changes: photo.changes, state: photo.state) }
                // Lead with what TonePilot decided and why; the AI's view is supporting evidence.
                if !photo.changes.isEmpty, let lead = photo.rationale.first(where: { $0 != skinLine }) {
                    Text(lead).font(Theme.secondaryStrong).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                }
                if !photo.reason.isEmpty {
                    Text((photo.changes.isEmpty ? "" : "AI assessment: ") + photo.reason).font(Theme.secondary).foregroundStyle(Theme.muted)
                        .lineLimit(disclosure.open ? nil : 2).fixedSize(horizontal: false, vertical: true)
                }
                if let skinLine {
                    Label(skinLine, systemImage: "face.smiling").font(Theme.secondaryStrong).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let conflict = photo.restoreConflict {
                    Label(conflict.reason, systemImage: "hand.raised.fill").font(Theme.secondaryStrong).foregroundStyle(Theme.attention)
                }
                if !photo.staleFields.isEmpty {
                    Label("Changed in Lightroom since analysis: " + photo.staleFields.joined(separator: ", "), systemImage: "pencil.circle")
                        .font(Theme.secondaryStrong).foregroundStyle(Theme.attention)
                }
                if let w = photo.write, let outcome = w.outcome, outcome != "verified" {
                    Label(writeSummary(w), systemImage: "exclamationmark.triangle").font(Theme.secondaryStrong).foregroundStyle(Theme.attention)
                }
                if let first = photo.warnings.first(where: { !hidden.contains($0) }), !disclosure.open {
                    Label(first, systemImage: "exclamationmark.circle").font(Theme.secondary).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Button { withAnimation(.easeOut(duration: 0.15)) { disclosure.open.toggle() } } label: {
                    HStack(spacing: 5) {
                        Text(disclosure.open ? "Hide details" : "Why, evidence and checks")
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).rotationEffect(.degrees(disclosure.open ? 180 : 0))
                    }
                }
                .buttonStyle(QuietButtonStyle())
                if disclosure.open { details.padding(.top, 2) }
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(approvable && isApproved ? Theme.accent.opacity(0.45) : Theme.line, lineWidth: approvable && isApproved ? 1.2 : 0.7))
        .accessibilityElement(children: .contain)
    }

    // The mandatory skin-tone verdict, shown on every card so "no change" is never silent.
    private var skinLine: String? {
        photo.rationale.first { $0.hasPrefix("Skin tone") || $0.hasPrefix("No skin") || $0.hasPrefix("Mixed light on skin") }
    }

    private func writeSummary(_ w: Outcome) -> String {
        var parts = [String]()
        if let m = w.mismatched, !m.isEmpty { parts.append("Read back differently: " + m.joined(separator: ", ")) }
        if let u = w.unexpected, !u.isEmpty { parts.append("Also changed: " + u.joined(separator: ", ")) }
        if parts.isEmpty, let e = w.error { parts.append(e) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(photo.rationale.filter { $0 != skinLine && ($0 != photo.rationale.first(where: { $0 != skinLine }) || photo.changes.isEmpty) }, id: \.self) {
                Label($0, systemImage: "arrow.right.circle").font(Theme.secondary).foregroundStyle(Theme.ink)
            }
            ForEach(photo.warnings.filter { !hidden.contains($0) }, id: \.self) {
                Label($0, systemImage: "exclamationmark.circle").font(Theme.secondary).foregroundStyle(Theme.attention)
            }
            if let ai = photo.ai {
                HStack(spacing: 6) {
                    ForEach([
                        ai.illuminant.map { "Light: " + Format.words($0) },
                        ai.subjectExposure.map { "Subject: " + Format.words($0) },
                        ai.skinCast.map { "Skin: " + Format.words($0) },
                        ai.intent.flatMap { $0 == "none" ? nil : "Intent: " + Format.words($0) },
                        (ai.mixedLighting ?? false) ? "Mixed lighting" : nil,
                        (ai.backlit ?? false) ? "Backlit" : nil
                    ].compactMap { $0 }, id: \.self) { Chip(text: $0) }
                }
            }
            if let m = photo.measurement { Text(measurementLine(m)).font(Theme.secondary).foregroundStyle(Theme.muted) }
            if let c = photo.confidence {
                Text("Model confidence \(Format.percent(c)) — self-reported by the AI and not calibrated; treat it as a hint.")
                    .font(Theme.secondary).foregroundStyle(Theme.muted)
            }
            if let p = photo.prior {
                Text("Already adjusted by an earlier TonePilot session (\(p.keys.joined(separator: ", "))). Limits count from your original values.")
                    .font(Theme.secondary).foregroundStyle(Theme.muted)
            }
            if let e = photo.aiError { Text("AI: " + e).font(Theme.secondary).foregroundStyle(Theme.muted) }
            if let r = photo.restore, let outcome = r.outcome, outcome != "restored" {
                Text("Restore: " + outcome + (r.error.map { " — " + $0 } ?? "")).font(Theme.secondary).foregroundStyle(Theme.attention)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 10))
    }

    private func measurementLine(_ m: Measurement) -> String {
        var s = m.subject == "face" ? "Measured \(Format.plural(m.faces, "face"))" : m.subject == "person" ? "Person found, no measurable face" : "No person found"
        if let clip = m.highlightClip { s += " · clipped highlights \(String(format: "%.1f", clip * 100))%" }
        if let after = photo.after, let a = after.subjectLuma, let b = m.subjectLuma, a > 0, b > 0 {
            s += " · after edit, subject " + String(format: "%+.2f EV", log2(a / b))
        }
        return s
    }
}

private struct ChangeTable: View {
    let changes: [ChangeRow]; let state: String
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
            ForEach(changes) { c in
                GridRow {
                    Text(c.label.uppercased()).font(.system(size: 12, weight: .bold)).tracking(0.9).foregroundStyle(Theme.muted)
                        .frame(minWidth: 96, alignment: .leading)
                    Text(Format.setting(c.key, c.original)).font(Theme.value).foregroundStyle(Theme.muted)
                    Image(systemName: "arrow.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.muted)
                    Text(Format.setting(c.key, c.proposed)).font(Theme.value.weight(.bold)).foregroundStyle(Theme.ink)
                    Text(Format.delta(c.key, from: c.original, to: c.proposed)).font(Theme.value).foregroundStyle(Theme.accent)
                    status(c)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 9))
        .accessibilityElement(children: .combine)
    }
    @ViewBuilder private func status(_ c: ChangeRow) -> some View {
        if let r = c.restored, state == "restored" {
            Label("restored to " + Format.setting(c.key, r), systemImage: "arrow.uturn.backward").font(Theme.secondaryStrong).foregroundStyle(Theme.muted)
        } else if let a = c.applied, state == "applied" || state == "apply-mismatch" {
            let matches = c.proposed.map { abs($0 - a) < 0.011 || (c.key == "Temperature" && abs($0 - a) < 2) } ?? false
            Label(matches ? "verified" : "read back " + Format.setting(c.key, a), systemImage: matches ? "checkmark" : "exclamationmark.triangle")
                .font(Theme.secondaryStrong).foregroundStyle(matches ? Theme.verified : Theme.attention)
        } else { Text("") }
    }
}
