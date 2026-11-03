import SwiftUI
import UIKit

/// قفل التطبيق وغطاء مبدّل التطبيقات في نافذة مستقلة فوق نافذة التطبيق (ADR 0113، تعديل لـ ADR 0009 §6). ما يُعرض في النافذة
/// الأولى بـ `fullScreenCover` أو `sheet` أو تنبيه (الإرسال، والمشغّل ملء الشاشة، والإيصال، واللقطة البديلة) يُرسم فوق كل ما في
/// تلك النافذة، فكان القفل والغطاء أخوين تحته: يُتجاوز القفل بشاشة مفتوحة، وتظهر في لقطة المبدّل. نافذة بمستوى فوق التنبيهات لا
/// يُرسم فوقها شيء من التطبيق.
@MainActor
final class PrivacyShield: ObservableObject {
    /// شاشة القفل: الدخول قائم والقفل مفعّل ومقفل.
    @Published private(set) var showsLock = false
    /// المشهد غير نشط (مبدّل التطبيقات، ومركز التحكم، ومطالبة النظام): غطاء يخفي المحتوى قبل أن يلتقط النظام لقطته.
    @Published private(set) var coversContent = false
    /// حالة المشهد كما تراها نافذة الدرع (شاشة القفل تطلب المصادقة حين يكون نشطًا).
    @Published var scenePhase: ScenePhase = .active
    /// النافذة أُنشئت. قبلها (أول إطار عند الإطلاق) يبقى القفل في نافذة التطبيق نفسها احتياطًا.
    @Published private(set) var isInstalled = false

    private var window: UIWindow?
    private weak var appWindow: UIWindow?
    private var observers: [NSObjectProtocol] = []

    /// تُنشأ النافذة مرة على مشهد نافذة التطبيق. الغطاء يتبع إشعارات المشهد نفسه (تصل قبل لقطة المبدّل)، لا دورة تحديث SwiftUI.
    func install<Content: View>(above appWindow: UIWindow, @ViewBuilder content: () -> Content) {
        guard window == nil, let scene = appWindow.windowScene else { return }
        self.appWindow = appWindow
        let shield = UIWindow(windowScene: scene)
        shield.windowLevel = .alert + 1
        shield.backgroundColor = .clear
        let host = UIHostingController(rootView: content())
        host.view.backgroundColor = .clear
        shield.rootViewController = host
        shield.isHidden = true
        window = shield
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIScene.willDeactivateNotification, object: scene, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.setCovered(true) }
            },
            center.addObserver(forName: UIScene.didActivateNotification, object: scene, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.setCovered(false) }
            },
        ]
        coversContent = scene.activationState != .foregroundActive
        isInstalled = true
        sync()
    }

    func setLocked(_ locked: Bool) {
        guard showsLock != locked else { return }
        showsLock = locked
        sync()
    }

    private func setCovered(_ covered: Bool) {
        guard coversContent != covered else { return }
        coversContent = covered
        sync()
    }

    private func sync() {
        guard let window else { return }
        if showsLock {
            // لا لوحة مفاتيح ولا عنصر وصول من النافذة التي تحته: القفل وحده يستقبل اللمس وقارئ الشاشة.
            appWindow?.endEditing(true)
            appWindow?.accessibilityElementsHidden = true
            window.isHidden = false
            window.makeKey()
        } else if coversContent {
            appWindow?.accessibilityElementsHidden = false
            window.isHidden = false
        } else {
            appWindow?.accessibilityElementsHidden = false
            window.isHidden = true
            if window.isKeyWindow { appWindow?.makeKey() }
        }
    }
}

/// ما في نافذة الدرع: شاشة القفل، أو غطاء معتم بلون الخلفية. معتم لا مموّه: التمويه يُبقي أشكال المحتوى وألوانه في لقطة المبدّل.
struct PrivacyShieldView: View {
    @ObservedObject var shield: PrivacyShield

    var body: some View {
        Group {
            if shield.showsLock {
                AppLockView().environment(\.scenePhase, shield.scenePhase)
            } else if shield.coversContent {
                Color.vl.bgBase.ignoresSafeArea()
            }
        }
        .tint(Color.vl.actionPrimary)
    }
}

/// يجد نافذة التطبيق التي يُعرض فيها `RootView`، لتُنشأ نافذة الدرع على مشهدها.
struct WindowReader: UIViewRepresentable {
    let onWindow: (UIWindow) -> Void

    func makeUIView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.isUserInteractionEnabled = false
        view.onWindow = onWindow
        return view
    }

    func updateUIView(_ uiView: ReaderView, context: Context) {}

    final class ReaderView: UIView {
        var onWindow: ((UIWindow) -> Void)?
        /// بعد دورة التخطيط لا أثناءها: إنشاء النافذة يغيّر حالة منشورة.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            Task { @MainActor [weak self] in
                guard let self, let window = self.window else { return }
                self.onWindow?(window)
            }
        }
    }
}
