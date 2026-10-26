import SwiftUI

@main
struct PostHistoryApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .environmentObject(app.uploads)
                .environmentObject(app.materials)
                .environmentObject(app.notifications)
                .environmentObject(app.settings)
                .environmentObject(app.lock)
        }
    }
}
