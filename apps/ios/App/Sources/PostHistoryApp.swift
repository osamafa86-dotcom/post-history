import SwiftUI
import UIKit

@main
struct PostHistoryApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var app = AppModel()

    init() {
        Self.styleNavigationBars()
    }

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

    /// الشريط العلوي للنظام بخطَّي الهوية v2 وألوانها (كان مؤجَّلًا في ADR 0080): العنوان الكبير Rubik ExtraBold،
    /// والعادي Readex Pro Bold، ويتبعان حجم الخط الديناميكي؛ والخلفية `bg/base` بلا خط فاصل.
    private static func styleNavigationBars() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(named: "vl/bg-base")
        appearance.shadowColor = .clear
        let primary = UIColor(named: "vl/text-primary") ?? .label
        if let large = UIFont(name: VLTextRole.display.postScriptName, size: VLTextRole.display.size) {
            appearance.largeTitleTextAttributes = [.font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: large), .foregroundColor: primary]
        }
        if let title = UIFont(name: VLTextRole.headline.postScriptName, size: VLTextRole.headline.size) {
            appearance.titleTextAttributes = [.font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: title), .foregroundColor: primary]
        }
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
        UINavigationBar.appearance().tintColor = UIColor(named: "vl/action-primary")
    }
}
