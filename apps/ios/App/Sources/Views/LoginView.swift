import AuthCore
import SwiftUI

/// شاشة الدخول بنظام التصميم. لا إطار لها في Figma، فهي مشتقة من الشريط العلوي للإطارين 186:423 و186:472 (شريط داكن باسم العلامة بخط العرض)
/// ومكوّني Form Field وButton وAlert والرموز. الحقول الثلاثة والسلوك وقاعدة التعطيل ومفاتيح النصوص كما كانت؛ حقل رمز التحقق يظهر «اختياريًا»
/// لأن المراسل لا يحتاجه (يُطلب فقط لمن فعّل المصادقة الثنائية).
struct LoginView: View {
    @EnvironmentObject private var app: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var totpCode = ""
    @State private var error: AuthError?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            VLBrandHeader(nameKey: "login.brand")
            ScrollView {
                VStack(alignment: .leading, spacing: VL.Space.s7) {
                    Text("login.title")
                        .vlText(.headingH1)
                        .foregroundStyle(Color.vl.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    VStack(alignment: .leading, spacing: VL.Space.s5) {
                        VLField(label: Text("login.email")) {
                            TextField(text: $email, prompt: Text(verbatim: "")) { Text("login.email") }
                                .textContentType(.username)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        VLField(label: Text("login.password")) {
                            SecureField(text: $password, prompt: Text(verbatim: "")) { Text("login.password") }
                                .textContentType(.password)
                        }
                        VLField(label: Text("login.totp"), isOptional: true, help: Text("login.totp.help")) {
                            TextField(text: $totpCode, prompt: Text(verbatim: "")) { Text("login.totp") }
                                .textContentType(.oneTimeCode)
                                .keyboardType(.numberPad)
                        }
                    }
                    if let error {
                        VLAlert(tone: .bad, systemImage: "exclamationmark.triangle.fill", text: error.messageKey)
                    }
                    Button { Task { await submit() } } label: {
                        if busy { ProgressView().tint(Color.vl.textSecondary) } else { Text("login.submit") }
                    }
                    .buttonStyle(.vlPrimary)
                    .disabled(busy || email.isEmpty || password.count < 8)
                }
                .padding(VL.Space.s5)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Color.vl.bgCanvas.ignoresSafeArea())
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            try await app.login(email: email, password: password, totpCode: totpCode)
            error = nil
        } catch let e as AuthError {
            error = e
        } catch {
            self.error = .transport(String(describing: type(of: error)))
        }
    }
}
