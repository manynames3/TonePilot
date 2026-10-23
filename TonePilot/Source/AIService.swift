import Foundation
import Security

// The AI service that assesses previews: the Codex CLI on the photographer's ChatGPT plan
// (default), Claude on Amazon Bedrock, or Claude through the Anthropic API. Choices live in
// UserDefaults; API keys only in the macOS Keychain, read fresh for each engine run.
enum AIProvider: String, CaseIterable, Identifiable {
    case codex, bedrock, anthropic
    var id: String { rawValue }
    var isClaude: Bool { self != .codex }
    var name: String {
        switch self {
        case .codex: return "ChatGPT subscription"
        case .bedrock: return "Amazon Bedrock"
        case .anthropic: return "Anthropic API"
        }
    }
    var tagline: String {
        switch self {
        case .codex: return "NO PER-PHOTO COST"
        case .bedrock: return "YOUR AWS ACCOUNT"
        case .anthropic: return "PAY AS YOU GO"
        }
    }
    var detail: String {
        switch self {
        case .codex: return "Uses your ChatGPT plan through the Codex CLI."
        case .bedrock: return "Claude in your AWS account, which pays per photo."
        case .anthropic: return "Claude with your API key, billed per photo."
        }
    }
    // Where previews go, for the line under "Analyze".
    var destination: String {
        switch self {
        case .codex: return "your ChatGPT plan (Codex)"
        case .bedrock: return "Claude on Amazon Bedrock"
        case .anthropic: return "Claude through the Anthropic API"
        }
    }
    var keyAccount: String? {
        switch self {
        case .codex: return nil
        case .bedrock: return "aws-bearer-token-bedrock"
        case .anthropic: return "anthropic-api-key"
        }
    }
}

enum AIModel: String, CaseIterable, Identifiable {
    case opus, sonnet, haiku
    var id: String { rawValue }
    var name: String { rawValue.capitalizedFirst + " 5.5" }
    func modelID(_ provider: AIProvider) -> String { (provider == .bedrock ? "anthropic." : "") + "claude-\(rawValue)-5-5" }
}

// Generic passwords under one service. Snapshot mode never touches the Keychain, so no
// screenshot can show a key, even masked.
enum Keychain {
    static let service = "app.tonepilot.ai"
    private static var disabled: Bool { ProcessInfo.processInfo.environment["TONEPILOT_SNAPSHOT_DIR"] != nil }
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    static func read(_ account: String) -> String? {
        guard !disabled else { return nil }
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    @discardableResult static func save(_ account: String, _ value: String) -> Bool {
        guard !disabled else { return false }
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecItemNotFound else { return status == errSecSuccess }
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    static func delete(_ account: String) {
        guard !disabled else { return }
        SecItemDelete(query(account) as CFDictionary)
    }
}

// Setup edits a draft; save() makes it what the engine uses.
@MainActor
final class AIServiceSettings: ObservableObject {
    private static let defaults = UserDefaults.standard
    @Published var provider = AIProvider.codex
    @Published var model = AIModel.opus
    @Published var region = ""
    @Published var profile = ""
    @Published var newKey = ""                                   // typed, not yet saved
    @Published private(set) var active = AIProvider.codex        // what the engine uses
    @Published private(set) var keyHints: [String: String] = [:] // account → "••••ab12"
    @Published var saveFailed = false

    init() { load() }

    // A provider from the launch environment applies until the photographer saves a choice.
    private static var savedProvider: AIProvider {
        AIProvider(rawValue: defaults.string(forKey: "aiProvider") ?? ProcessInfo.processInfo.environment["TONEPILOT_AI_PROVIDER"] ?? "") ?? .codex
    }
    private static var savedModel: AIModel { AIModel(rawValue: defaults.string(forKey: "aiModel") ?? "") ?? .opus }
    private static var savedRegion: String { defaults.string(forKey: "awsRegion") ?? "us-east-1" }
    private static var savedProfile: String { defaults.string(forKey: "awsProfile") ?? "" }

    func load() {
        active = Self.savedProvider
        provider = active; model = Self.savedModel; region = Self.savedRegion; profile = Self.savedProfile; newKey = ""
        keyHints = Dictionary(uniqueKeysWithValues: AIProvider.allCases.compactMap { p in
            p.keyAccount.flatMap { account in Keychain.read(account).map { (account, "••••••••" + String($0.suffix(4))) } }
        })
    }

    var keyHint: String? { provider.keyAccount.flatMap { keyHints[$0] } }
    var dirty: Bool {
        provider != Self.savedProvider || (provider.isClaude && model != Self.savedModel) || !newKey.isEmpty
            || (provider == .bedrock && (clean(region, "us-east-1") != Self.savedRegion || clean(profile) != Self.savedProfile))
    }
    private func clean(_ s: String, _ fallback: String = "") -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? fallback : t
    }

    func save() {
        let d = Self.defaults
        d.set(provider.rawValue, forKey: "aiProvider")
        d.set(model.rawValue, forKey: "aiModel")
        d.set(clean(region, "us-east-1"), forKey: "awsRegion")
        d.set(clean(profile), forKey: "awsProfile")
        let key = clean(newKey)
        saveFailed = false
        if !key.isEmpty, let account = provider.keyAccount { saveFailed = !Keychain.save(account, key) }
        load()
    }

    func removeKey() {
        guard let account = provider.keyAccount else { return }
        Keychain.delete(account)
        load()
    }

    // The saved choice as engine environment, keys read from the Keychain now. Nothing is
    // set until a choice has been saved, so a developer's own environment still applies.
    nonisolated static func apply(to env: inout [String: String]) {
        let d = UserDefaults.standard
        guard let provider = AIProvider(rawValue: d.string(forKey: "aiProvider") ?? "") else { return }
        env["TONEPILOT_AI_PROVIDER"] = provider.rawValue
        guard provider.isClaude else { return }
        env["TONEPILOT_AI_MODEL"] = (AIModel(rawValue: d.string(forKey: "aiModel") ?? "") ?? .opus).modelID(provider)
        if provider == .bedrock {
            env["TONEPILOT_AWS_REGION"] = d.string(forKey: "awsRegion") ?? "us-east-1"
            let profile = d.string(forKey: "awsProfile") ?? ""
            env["TONEPILOT_AWS_PROFILE"] = profile.isEmpty ? nil : profile
        }
        if let account = provider.keyAccount, let key = Keychain.read(account) {
            env[provider == .bedrock ? "AWS_BEARER_TOKEN_BEDROCK" : "ANTHROPIC_API_KEY"] = key
        }
    }
}
