import Foundation

// Decoded views produced by the engine. The app holds no recovery state of its own:
// every session's status and available actions come from the engine's journal fold,
// so a relaunch, crash or second window always sees the same truth.

struct DoctorReport: Decodable { let ready: Bool; let checks: [Check] }
struct Check: Decodable, Identifiable, Hashable {
    let id: String; let ok: Bool; let severity: String; let title: String
    let detail: String?; let fix: String?
    var required: Bool { severity == "required" }
}

struct SelectionReport: Decodable {
    let count: Int; let limit: Int; let truncated: Bool
    let bridge: String?; let testedBridge: String?
    let photos: [SelectedPhoto]
    var overLimit: Bool { count > limit }
}
struct SelectedPhoto: Decodable, Identifiable, Hashable {
    let id: String; let filename: String; let captureTime: String?; let format: String
    var isRaw: Bool { !["JPG", "JPEG", "HEIC", "HEIF", "TIF", "TIFF", "PNG", "PSD", "MOV", "MP4", "AVIF"].contains(format) }
}

struct Actions: Decodable, Equatable, Hashable {
    let resumeAnalysis: Bool; let apply: Bool; let restore: Bool; let reconcile: Bool; let discard: Bool
}

struct SessionsReport: Decodable { let sessions: [SessionSummary]; let running: RunningEngine? }
struct RunningEngine: Decodable, Equatable { let mode: String; let session: String? }

struct SessionSummary: Decodable, Identifiable, Hashable {
    let id: String; let dir: String
    let createdAt: String?; let updatedAt: String?
    let look: String?; let strength: String?; let photoCount: Int?
    let status: String; let label: String; let explanation: String?
    let counts: [String: Int]?; let actions: Actions?; let attention: Bool?; let running: String?
    var created: Date? { (createdAt ?? updatedAt).flatMap(ISO8601.parse) }
    var isLegacy: Bool { status == "legacy" }
}

struct SessionView: Decodable, Identifiable {
    let id: String; let dir: String
    let createdAt: String?; let updatedAt: String?
    let look: String?; let strength: String?
    let enabled: [String: Bool]?
    let policy: Policy?
    let status: String; let label: String; let explanation: String
    let counts: [String: Int]; let actions: Actions; let attention: Bool
    let present: Int; let restored: Int; let unresolved: [String]; let candidates: Int
    let scenes: [SceneInfo]; let errors: [SessionError]; let analysisError: String?
    let photos: [PhotoView]
    let running: String?
    var created: Date? { createdAt.flatMap(ISO8601.parse) }
    func count(_ state: String) -> Int { counts[state] ?? 0 }
}

struct Policy: Decodable { let look: String; let strength: String; let fraction: Double; let minConfidence: Double; let caps: [String: Double] }
struct SessionError: Decodable, Hashable { let at: String?; let phase: String?; let message: String }
struct SceneInfo: Decodable, Identifiable, Hashable {
    let id: String; let photos: [String]; let reference: String?
    let startedBecause: [String]?; let span: Span?; let flash: Bool?
    struct Span: Decodable, Hashable { let from: String; let to: String }
}

struct PhotoView: Decodable, Identifiable, Hashable {
    let id: String; let filename: String; let state: String; let stateLabel: String
    let format: String; let scene: String?; let approved: Bool
    let changes: [ChangeRow]
    let reason: String; let rationale: [String]; let warnings: [String]
    let confidence: Double?; let confidenceNote: String?
    let ai: AIJudgment?; let aiError: String?
    let measurement: Measurement?; let after: After?
    let prior: Prior?; let staleFields: [String]; let restoreConflict: Conflict?
    let write: Outcome?; let restore: Outcome?

    var isApplicable: Bool { state == "proposed" || state == "apply-failed" }
    var needsReview: Bool { ["flagged", "stale", "apply-mismatch", "restore-mismatch", "writing", "restoring", "apply-failed"].contains(state) || restoreConflict != nil }
}

struct ChangeRow: Decodable, Identifiable, Hashable {
    let key: String; let label: String
    let original: Double?; let origin: Double?; let proposed: Double?; let applied: Double?; let restored: Double?
    var id: String { key }
}
struct AIJudgment: Decodable, Hashable {
    let scene: String?; let illuminant: String?; let mixedLighting: Bool?; let backlit: Bool?
    let intent: String?; let skinCast: String?; let subjectExposure: String?
}
struct Measurement: Decodable, Hashable {
    let subject: String; let faces: Int; let subjectLuma: Double?; let highlightClip: Double?; let shadowClip: Double?
}
struct After: Decodable, Hashable { let subjectLuma: Double?; let highlightClip: Double? }
struct Prior: Decodable, Hashable { let session: String; let at: String?; let keys: [String]; let sessions: Int? }
struct Conflict: Decodable, Hashable { let at: String?; let reason: String; let fields: [String]? }
struct Outcome: Decodable, Hashable {
    let outcome: String?; let error: String?; let mismatched: [String]?; let unexpected: [String]?
    let wrong: [String]?; let reconciled: Bool?
}

// Progress events streamed while the engine works.
struct EngineEvent: Decodable {
    let type: String
    let step: String?; let phase: String?; let index: Int?; let total: Int?; let filename: String?
    let message: String?; let id: String?; let dir: String?; let stopped: String?
}

enum ISO8601 {
    static let fractional: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    static let plain = ISO8601DateFormatter()
    static func parse(_ s: String) -> Date? { fractional.date(from: s) ?? plain.date(from: s) }
}
