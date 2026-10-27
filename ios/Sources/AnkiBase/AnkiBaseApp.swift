import SwiftUI

@main
struct AnkiBaseApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView()
                .ignoresSafeArea()
                .background(Color(red: 0x16 / 255, green: 0x21 / 255, blue: 0x3e / 255))
        }
    }
}
