import SwiftUI

// Design tokens. Native system colours and type everywhere; one restrained accent.
enum Theme {
    // Burnt orange: 5.7:1 against white text, distinct from the system blue of links.
    static let accent = Color(red: 0.76, green: 0.29, blue: 0.08)
    static let verified = Color(nsColor: .systemGreen)
    static let attention = Color(nsColor: .systemOrange)
    static let danger = Color(nsColor: .systemRed)
    static let neutral = Color(nsColor: .secondaryLabelColor)
    static let info = Color(nsColor: .systemBlue)
    static let card = Color(nsColor: .controlBackgroundColor)
    static let separator = Color(nsColor: .separatorColor)

    static let title = Font.system(size: 26, weight: .semibold)
    static let heading = Font.system(size: 17, weight: .semibold)
    static let body = Font.system(size: 15)
    static let bodyStrong = Font.system(size: 15, weight: .semibold)
    static let secondary = Font.system(size: 13)
    static let secondaryStrong = Font.system(size: 13, weight: .semibold)
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
    case "planned": return .info
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

struct StatusBadge: View {
    let label: String
    let tone: Tone
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(tone.color).frame(width: 8, height: 8)
            Text(label).font(Theme.secondaryStrong)
        }
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(tone.color.opacity(0.13), in: Capsule())
        .foregroundStyle(.primary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(label)")
    }
}

struct Chip: View {
    let text: String
    var systemImage: String? = nil
    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(Theme.secondary)
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
        .foregroundStyle(.secondary)
    }
}

struct Card<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.heading)
                if let subtitle { Text(subtitle).font(Theme.secondary).foregroundStyle(.secondary) }
            }
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.separator.opacity(0.6), lineWidth: 0.5))
    }
}

struct Callout: View {
    let tone: Tone
    let systemImage: String
    let title: String
    let message: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(tone.color).font(.system(size: 16, weight: .semibold))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.bodyStrong)
                Text(message).font(Theme.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(tone.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
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

struct KeyHint: View {
    let keys: String
    var body: some View {
        Text(keys).font(.system(size: 12, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.separator, lineWidth: 0.8))
            .accessibilityHidden(true)
    }
}
