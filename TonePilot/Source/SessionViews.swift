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
    // is said once in the header instead of on every row.
    private var commonWarnings: Set<String> {
        let analyzed = session.photos.filter { $0.state != "unsupported" }
        guard analyzed.count > 1, let first = analyzed.first else { return [] }
        return Set(first.warnings.filter { w in analyzed.allSatisfy { $0.warnings.contains(w) } })
    }

    var body: some View {
        list
            .onKeyPress(.space) { toggleFocused() }
            .safeAreaInset(edge: .bottom) { actionBar }
            .modifier(Confirmations(model: model, session: session, ui: ui, approvedCount: approvedApplicable.count))
    }

    private var list: some View {
        List(selection: $ui.focused) {
            Section { header }.listRowSeparator(.hidden)
            ForEach(Array(session.scenes.enumerated()), id: \.element.id) { index, scene in
                sceneSection(scene, index: index + 1)
            }
            looseSection
        }
        .listStyle(.inset)
    }

    private func sceneSection(_ scene: SceneInfo, index: Int) -> some View {
        Section {
            ForEach(photos(in: scene)) { photo in
                PhotoRow(photo: photo, session: session, isReference: scene.reference == photo.id, hidden: commonWarnings).tag(photo.id)
            }
        } header: { SceneHeader(scene: scene, index: index) }
    }

    @ViewBuilder private var looseSection: some View {
        let loose = session.photos.filter { $0.scene == nil }
        if !loose.isEmpty {
            Section("Not analyzed") {
                ForEach(loose) { photo in PhotoRow(photo: photo, session: session, isReference: false, hidden: commonWarnings).tag(photo.id) }
            }
        }
    }

    private func toggleFocused() -> KeyPress.Result {
        guard let id = ui.focused, let p = session.photos.first(where: { $0.id == id }), p.isApplicable, session.actions.apply else { return .ignored }
        model.toggleApproval(p, in: session)
        return .handled
    }
}

final class SessionUIState: ObservableObject {
    @Published var confirmApply = false
    @Published var confirmRestore = false
    @Published var confirmDiscard = false
    @Published var focused: String?
}

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

extension SessionDetailView {

    private func photos(in scene: SceneInfo) -> [PhotoView] {
        scene.photos.compactMap { id in session.photos.first { $0.id == id } }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                StatusBadge(label: session.running.map { _ in "Working…" } ?? session.label, tone: sessionTone(session.status))
                Text(Format.date(session.created)).font(Theme.heading)
                Spacer()
                Chip(text: (session.look ?? "") + " · " + (session.strength ?? ""), systemImage: "slider.horizontal.3")
            }
            Text(session.explanation).font(Theme.body).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 22) {
                Metric(value: session.count("proposed") + session.count("apply-failed"), label: "to apply", tone: .accent)
                Metric(value: session.present, label: "in Lightroom", tone: .verified)
                Metric(value: session.restored, label: "restored", tone: .neutral)
                Metric(value: session.count("skipped"), label: "left unchanged", tone: .neutral)
                Metric(value: review.count, label: "need review", tone: review.isEmpty ? .neutral : .attention)
                Metric(value: session.count("unsupported"), label: "unsupported", tone: .neutral)
            }
            attentionCallout
            ForEach(Array(commonWarnings).sorted(), id: \.self) { w in
                Label(w, systemImage: "info.circle").font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let error = session.analysisError ?? session.errors.last?.message {
                Text("Last problem: " + error).font(Theme.secondary).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .padding(.vertical, 8)
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
        default:
            if session.photos.contains(where: { $0.state == "apply-mismatch" }) {
                Callout(tone: .attention, systemImage: "exclamationmark.triangle.fill", title: "Some photos read back differently than planned",
                        message: "Lightroom stored a slightly different value or another setting changed at the same moment. Check the flagged photos.")
            }
        }
    }

    // MARK: Actions

    private var actionBar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 12) {
                if !review.isEmpty {
                    Button { model.copyFilenames(review) } label: { Label("Copy \(Format.plural(review.count, "filename")) to review", systemImage: "doc.on.doc") }
                        .help("Paste into Lightroom's Library Filter text search to see these photos")
                }
                Button { model.revealSession(session) } label: { Label("Report", systemImage: "doc.text") }
                Spacer()
                if session.actions.discard && session.status != "restored" && session.status != "discarded" {
                    Button("Discard plan…") { ui.confirmDiscard = true }
                }
                if session.actions.restore {
                    Button("Restore originals…") { ui.confirmRestore = true }.controlSize(.large)
                }
                primary
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .disabled(model.busy || session.running != nil)
        }
        .background(.bar)
    }

    @ViewBuilder private var primary: some View {
        if session.actions.reconcile {
            Button { Task { await model.reconcile(session) } } label: { Text("Check Lightroom now").font(Theme.bodyStrong).frame(minWidth: 160) }
                .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.return, modifiers: .command)
        } else if session.actions.resumeAnalysis {
            Button { Task { await model.resumeAnalysis(session) } } label: { Text("Resume analysis").font(Theme.bodyStrong).frame(minWidth: 160) }
                .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.return, modifiers: .command)
        } else if session.actions.apply {
            Menu {
                Button("Approve all \(session.candidates)") { model.setAllApprovals(true, in: session) }
                Button("Approve none") { model.setAllApprovals(false, in: session) }
            } label: { Text("\(approvedApplicable.count) of \(session.candidates) approved") }
                .menuStyle(.borderlessButton).fixedSize()
            Button { ui.confirmApply = true } label: {
                Text(approvedApplicable.isEmpty ? "Approve edits to apply" : "Apply \(Format.plural(approvedApplicable.count, "edit"))")
                    .font(Theme.bodyStrong).frame(minWidth: 160)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(approvedApplicable.isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
        }
    }
}

private struct Metric: View {
    let value: Int; let label: String; let tone: Tone
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(value)").font(.system(size: 20, weight: .semibold)).monospacedDigit()
                .foregroundStyle(value == 0 ? Color.secondary : tone.color)
            Text(label).font(Theme.secondary).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct SceneHeader: View {
    let scene: SceneInfo; let index: Int
    var body: some View {
        HStack(spacing: 8) {
            Text("Scene \(index)").font(Theme.secondaryStrong)
            Text(Format.plural(scene.photos.count, "photo")).font(Theme.secondary)
            if let flash = scene.flash { Chip(text: flash ? "Flash" : "Ambient light", systemImage: flash ? "bolt.fill" : "sun.max") }
            if let reasons = scene.startedBecause, index > 1, !reasons.isEmpty {
                Text("New scene: " + reasons.joined(separator: ", ")).font(Theme.secondary).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .foregroundStyle(.primary)
        .textCase(nil)
    }
}

// MARK: Photo row

struct PhotoRow: View {
    @EnvironmentObject var model: AppModel
    let photo: PhotoView
    let session: SessionView
    let isReference: Bool
    var hidden: Set<String> = []
    @StateObject private var disclosure = Disclosure()
    private var expanded: Bool { disclosure.open }

    private var approvable: Bool { photo.isApplicable && session.actions.apply }
    private var isApproved: Bool { (model.approvals[session.id] ?? []).contains(photo.id) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if approvable {
                Toggle("", isOn: Binding(get: { isApproved }, set: { _ in model.toggleApproval(photo, in: session) }))
                    .toggleStyle(.checkbox).labelsHidden()
                    .accessibilityLabel("Approve edit for \(photo.filename)")
                    .padding(.top, 2)
            } else {
                Color.clear.frame(width: 16, height: 16)
            }
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(photo.filename).font(Theme.bodyStrong).textSelection(.enabled)
                    if !photo.format.isEmpty { Chip(text: photo.format) }
                    if isReference { Chip(text: "Scene reference", systemImage: "scope") }
                    Spacer()
                    StatusBadge(label: photo.stateLabel, tone: photoTone(photo.state))
                }
                if !photo.changes.isEmpty { ChangeTable(changes: photo.changes, state: photo.state) }
                if !photo.reason.isEmpty {
                    Text(photo.reason).font(Theme.secondary).foregroundStyle(.secondary).lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let conflict = photo.restoreConflict {
                    Label(conflict.reason, systemImage: "hand.raised.fill").font(Theme.secondary).foregroundStyle(Theme.attention)
                }
                if !photo.staleFields.isEmpty {
                    Label("Changed in Lightroom: " + photo.staleFields.joined(separator: ", "), systemImage: "pencil.circle")
                        .font(Theme.secondary).foregroundStyle(Theme.attention)
                }
                if let w = photo.write, let outcome = w.outcome, outcome != "verified" {
                    Label(writeSummary(w), systemImage: "exclamationmark.triangle").font(Theme.secondary).foregroundStyle(Theme.attention)
                }
                if let first = photo.warnings.first(where: { !hidden.contains($0) }), !expanded {
                    Label(first, systemImage: "exclamationmark.circle").font(Theme.secondary).foregroundStyle(.secondary).lineLimit(1)
                }
                DisclosureGroup(isExpanded: $disclosure.open) { details.padding(.top, 4) } label: {
                    Text(expanded ? "Hide details" : "Why, evidence and checks").font(Theme.secondary).foregroundStyle(Theme.info)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
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
            ForEach(photo.rationale, id: \.self) { Label($0, systemImage: "arrow.right.circle").font(Theme.secondary) }
            ForEach(photo.warnings.filter { !hidden.contains($0) }, id: \.self) { Label($0, systemImage: "exclamationmark.circle").font(Theme.secondary).foregroundStyle(Theme.attention) }
            if let ai = photo.ai {
                FlowChips(items: [
                    ai.illuminant.map { "Light: " + Format.words($0) },
                    ai.subjectExposure.map { "Subject: " + Format.words($0) },
                    ai.skinCast.map { "Skin: " + Format.words($0) },
                    ai.intent.flatMap { $0 == "none" ? nil : "Intent: " + Format.words($0) },
                    (ai.mixedLighting ?? false) ? "Mixed lighting" : nil,
                    (ai.backlit ?? false) ? "Backlit" : nil
                ].compactMap { $0 })
            }
            if let m = photo.measurement {
                Text(measurementLine(m)).font(Theme.secondary).foregroundStyle(.secondary)
            }
            if let c = photo.confidence {
                Text("Model confidence \(Format.percent(c)) — self-reported by the AI and not calibrated; treat as a hint.")
                    .font(Theme.secondary).foregroundStyle(.secondary)
            }
            if let p = photo.prior {
                Text("Already adjusted by an earlier TonePilot session (\(p.keys.joined(separator: ", "))). Limits count from your original values.")
                    .font(Theme.secondary).foregroundStyle(.secondary)
            }
            if let e = photo.aiError { Text("AI: " + e).font(Theme.secondary).foregroundStyle(.secondary) }
            if let r = photo.restore, let outcome = r.outcome, outcome != "restored" {
                Text("Restore: " + outcome + (r.error.map { " — " + $0 } ?? "")).font(Theme.secondary).foregroundStyle(Theme.attention)
            }
        }
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

final class Disclosure: ObservableObject { @Published var open = false }

private struct ChangeTable: View {
    let changes: [ChangeRow]; let state: String
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 3) {
            ForEach(changes) { c in
                GridRow {
                    Text(c.label).font(Theme.secondaryStrong).frame(minWidth: 86, alignment: .leading)
                    Text(Format.setting(c.key, c.original)).font(Theme.value).foregroundStyle(.secondary)
                    Image(systemName: "arrow.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    Text(Format.setting(c.key, c.proposed)).font(Theme.value)
                    Text(Format.delta(c.key, from: c.original, to: c.proposed)).font(Theme.value).foregroundStyle(Theme.accent)
                    status(c)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
    @ViewBuilder private func status(_ c: ChangeRow) -> some View {
        if let r = c.restored, state == "restored" {
            Label("restored to " + Format.setting(c.key, r), systemImage: "arrow.uturn.backward").font(Theme.secondary).foregroundStyle(.secondary)
        } else if let a = c.applied, state == "applied" || state == "apply-mismatch" {
            let matches = c.proposed.map { abs($0 - a) < 0.011 || (c.key == "Temperature" && abs($0 - a) < 2) } ?? false
            Label(matches ? "verified" : "read back " + Format.setting(c.key, a), systemImage: matches ? "checkmark" : "exclamationmark.triangle")
                .font(Theme.secondary).foregroundStyle(matches ? Theme.verified : Theme.attention)
        } else { Text("") }
    }
}

private struct FlowChips: View {
    let items: [String]
    var body: some View {
        HStack(spacing: 6) { ForEach(items, id: \.self) { Chip(text: $0) } }
    }
}
