import SwiftUI

// TonePilot's editorial design language: warm paper, serif display type, tracked
// labels, terracotta for action, a charcoal rail for navigation. The window always uses
// this palette (it does not follow system Dark Mode), as TonePilot 0.4 did.
enum Theme {
    static let paper = Color(red: 0.969, green: 0.954, blue: 0.930)
    static let card = Color(red: 0.992, green: 0.980, blue: 0.962)
    static let sunken = Color(red: 0.941, green: 0.922, blue: 0.894)
    static let ink = Color(red: 0.130, green: 0.122, blue: 0.114)
    static let muted = Color(red: 0.410, green: 0.385, blue: 0.370)
    static let line = Color(red: 0.79, green: 0.76, blue: 0.72).opacity(0.65)
    static let accent = Color(red: 0.726, green: 0.334, blue: 0.235)
    static let accentLight = Color(red: 0.87, green: 0.55, blue: 0.41)
    static let rail = Color(red: 0.123, green: 0.113, blue: 0.106)
    static let railRaised = Color.white.opacity(0.07)
    static let cream = Color(red: 0.963, green: 0.904, blue: 0.795)
    static let railText = Color(red: 0.74, green: 0.69, blue: 0.65)
    static let disabledFill = Color(red: 0.88, green: 0.85, blue: 0.81)

    static let verified = Color(red: 0.33, green: 0.55, blue: 0.36)
    static let attention = Color(red: 0.78, green: 0.52, blue: 0.13)
    static let danger = Color(red: 0.71, green: 0.22, blue: 0.18)
    static let neutral = Color(red: 0.55, green: 0.52, blue: 0.49)
    static let info = Color(red: 0.33, green: 0.45, blue: 0.58)

    static func serif(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font { .system(size: size, weight: weight, design: .serif) }
    static let display = serif(36, .bold)
    static let title = serif(28, .bold)
    static let heading = serif(18)
    static let body = Font.system(size: 15, weight: .medium)
    static let bodyStrong = Font.system(size: 15, weight: .semibold)
    static let secondary = Font.system(size: 13, weight: .medium)
    static let secondaryStrong = Font.system(size: 13, weight: .semibold)
    static let label = Font.system(size: 13, weight: .bold)
    static let value = Font.system(size: 14, weight: .medium).monospacedDigit()
}

enum Tone { case verified, attention, danger, neutral, info, accent
    var color: Color {
        switch self {
        case .verified: return Theme.verified
        case .attention: return Theme.attention
        case .danger: return Theme.danger
        case .neutral: return Theme.neutral
        case .info: return Theme.info
        case .accent: return Theme.accent
        }
    }
}

func sessionTone(_ status: String) -> Tone {
    switch status {
    case "applied": return .verified
    case "planned": return .accent
    case "interrupted", "damaged": return .danger
    case "partially-applied", "partially-restored", "analysis-incomplete", "analysis-failed": return .attention
    default: return .neutral
    }
}

func photoTone(_ state: String) -> Tone {
    switch state {
    case "proposed": return .accent
    case "applied": return .verified
    case "flagged", "stale", "apply-mismatch": return .attention
    case "writing", "restoring", "apply-failed", "restore-mismatch": return .danger
    default: return .neutral
    }
}

// MARK: Type

struct SectionLabel: View {
    let step: String?
    let title: String
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 10) {
            if let step {
                Text(step).font(Theme.label).tracking(1.5)
                Text("·").font(.system(size: 15, weight: .bold))
            }
            Text(title.uppercased()).font(Theme.label).tracking(1.5)
            Spacer(minLength: 8)
            if let trailing { Text(trailing.uppercased()).font(Theme.label).tracking(1.0).foregroundStyle(Theme.muted) }
        }
        .foregroundStyle(Theme.ink)
        .accessibilityElement(children: .combine)
    }
}

struct Rule: View {
    var body: some View { Theme.line.frame(height: 0.8) }
}

// MARK: Containers

struct PaperCard<Content: View>: View {
    var padding: CGFloat = 18
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 0.7))
    }
}

struct Callout: View {
    let tone: Tone
    let systemImage: String
    let title: String
    let message: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage).font(.system(size: 17, weight: .semibold)).foregroundStyle(tone.color)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Theme.serif(16)).foregroundStyle(Theme.ink)
                Text(message).font(Theme.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(tone.color.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tone.color.opacity(0.28), lineWidth: 0.8))
        .accessibilityElement(children: .combine)
    }
}

// MARK: Small parts

struct StatusPill: View {
    let label: String
    let tone: Tone
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(tone.color).frame(width: 8, height: 8)
            Text(label).font(Theme.secondaryStrong)
        }
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, 11).frame(height: 27)
        .background(tone.color.opacity(0.13), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(label)")
    }
}

struct Chip: View {
    let text: String
    var systemImage: String? = nil
    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 11, weight: .semibold)) }
            Text(text).font(Theme.secondaryStrong)
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 8).frame(height: 22)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 6))
    }
}

struct Monogram: View {
    var body: some View {
        ZStack {
            Circle().fill(Theme.card)
            Circle().strokeBorder(Theme.accent, lineWidth: 1.4)
            GeometryReader { g in
                HStack(spacing: 0) { Color.clear; Theme.accent.opacity(0.85) }.clipShape(Circle())
                Path { p in
                    let w = g.size.width, h = g.size.height
                    p.move(to: CGPoint(x: w * 0.45, y: h * 0.06)); p.addLine(to: CGPoint(x: w * 0.45, y: h * 0.94))
                    p.move(to: CGPoint(x: w * 0.14, y: h * 0.52)); p.addLine(to: CGPoint(x: w * 0.45, y: h * 0.52))
                    p.addLine(to: CGPoint(x: w * 0.74, y: h * 0.19))
                }
                .stroke(Theme.ink.opacity(0.65), lineWidth: 1.3)
            }
            .padding(5)
        }
        .accessibilityHidden(true)
    }
}

// MARK: Buttons and toggles

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.serif(17, .bold))
            .foregroundStyle(isEnabled ? Color.white : Theme.ink.opacity(0.55))
            .padding(.horizontal, 22).frame(minHeight: 50)
            .background(isEnabled ? Theme.accent.opacity(configuration.isPressed ? 0.88 : 1) : Theme.disabledFill,
                        in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
            .scaleEffect(configuration.isPressed && isEnabled ? 0.99 : 1)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Theme.ink.opacity(isEnabled ? 1 : 0.45))
            .padding(.horizontal, 14).frame(minHeight: 38)
            .background(Theme.card.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.accent.opacity(isEnabled ? 0.5 : 0.2), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct QuietButtonStyle: ButtonStyle {
    var color: Color = Theme.accent
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(color.opacity(configuration.isPressed ? 0.6 : 1))
            .contentShape(Rectangle())
    }
}

// Terracotta capsule switch, keyboard and VoiceOver accessible as a normal toggle.
struct CapsuleToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 14) {
                configuration.label
                Spacer(minLength: 8)
                Capsule()
                    .fill(configuration.isOn ? Theme.accent : Theme.neutral.opacity(0.35))
                    .frame(width: 44, height: 25)
                    .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                        Circle().fill(.white).frame(width: 19, height: 19).padding(3).shadow(color: .black.opacity(0.12), radius: 1, y: 0.5)
                    }
                    .animation(.easeOut(duration: 0.15), value: configuration.isOn)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

struct CheckboxStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            RoundedRectangle(cornerRadius: 5)
                .fill(configuration.isOn ? Theme.accent : Theme.card)
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(configuration.isOn ? Theme.accent : Theme.neutral.opacity(0.6), lineWidth: 1.2))
                .overlay { if configuration.isOn { Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(.white) } }
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "Approved" : "Not approved")
    }
}

struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 12) { configuration.title; configuration.icon.font(.system(size: 15, weight: .bold)) }
    }
}

struct KeyHint: View {
    let keys: String
    var body: some View {
        Text(keys).font(.system(size: 12, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 6).frame(height: 20)
            .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 5))
            .accessibilityHidden(true)
    }
}

// MARK: Value formatting (every number a photographer sees)

enum Format {
    static func setting(_ key: String, _ v: Double?) -> String {
        guard let v else { return "—" }
        switch key {
        case "Exposure2012": return String(format: "%+.2f", v)
        case "Temperature": return String(format: "%.0f K", v)
        default: return String(format: "%+.0f", v)
        }
    }
    static func delta(_ key: String, from: Double?, to: Double?) -> String {
        guard let from, let to else { return "" }
        let d = to - from
        switch key {
        case "Exposure2012": return String(format: "%+.2f EV", d)
        case "Temperature": return String(format: "%+.0f K", d)
        default: return String(format: "%+.0f", d)
        }
    }
    static func percent(_ v: Double?) -> String { v.map { String(format: "%.0f%%", $0 * 100) } ?? "—" }
    static func date(_ d: Date?) -> String {
        guard let d else { return "" }
        return d.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
    static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
    static func words(_ s: String?) -> String { (s ?? "").replacingOccurrences(of: "-", with: " ").capitalizedFirst }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
