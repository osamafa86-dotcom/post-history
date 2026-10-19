import UIKit

/// يستقبل إيقاظ النظام لأحداث الجلسة الخلفية ويمرّر مقبض الإكمال إلى النقل.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == UploadServices.backgroundSessionIdentifier else { return completionHandler() }
        UploadServices.shared.transport.backgroundCompletionHandler = completionHandler
    }
}
