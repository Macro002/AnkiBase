import AppIntents
import Foundation

/// The focus lock's Shortcuts action. A personal automation ("when Instagram is opened")
/// runs it; it opens AnkiBase unless today's cards are done. The engine keeps the moment
/// the apps lock again in `open-until` (app/focus.rs), so this only reads a number.
///
/// Shortcuts finds the action through Metadata.appintents, which only Xcode makes: the
/// "App Intents metadata" workflow builds this file on a Mac and commits ios/Metadata/.
/// Keep this file on its own (no other app code) and re-run that workflow when it changes.
struct FocusCheckIntent: AppIntent, ForegroundContinuableIntent {
    static let title: LocalizedStringResource = "Focus Lock"
    static let description = IntentDescription("Opens AnkiBase while today's cards aren't done. Use it in an automation for the apps you want to keep closed.")

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

    func perform() async throws -> some IntentResult {
        if FocusLock.isOpen() { return .result() }
        if #available(iOS 26.0, *) {
            try await continueInForeground(alwaysConfirm: false)
        } else {
            try await requestToContinueInForeground()
        }
        return .result()
    }
}

enum FocusLock {
    /// Where the engine keeps the lock's state; out of the Files app's reach.
    static let directory: URL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Focus", isDirectory: true)

    /// Whether other apps may open now. Without the engine's file (the lock was never set
    /// up) they may.
    static func isOpen(now: Date = Date()) -> Bool {
        let file = directory.appendingPathComponent("open-until")
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return true }
        guard let until = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return now.timeIntervalSince1970 < until
    }
}
