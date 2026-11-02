import AuthCore
import SwiftUI

/// 02 · الدخول (docs/design/specs/reporter-v2.md): «أهلًا بك» بخط العرض، وسطر يقول إن التطبيق يبقى مفتوحًا على هذا الهاتف،
/// وحقلان بمكوّن `Text field`، ورمز التحقق «اختياري» (لمن فعّل المصادقة الثنائية وحده، ADR 0080)، وزرّ Solid واحد.
/// الحقول والسلوك وقاعدة التعطيل كما كانت.
struct LoginView: View {
    @EnvironmentObject private var app: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var totpCode = ""
    @State private var error: AuthError?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VL.Space.s6) {
                AppMark(size: 56).padding(.top, VL.Space.s8)
                VStack(alignment: .leading, spacing: VL.Space.s3) {
                    Text("login.welcome")
                        .vlText(.display)
                        .foregroundStyle(Color.vl.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text("login.subtitle").vlText(.body).foregroundStyle(Color.vl.textSecondary)
                }
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
                    VLNote(tone: .danger, systemImage: "exclamationmark.triangle", text: Text(error.messageKey))
                }
                Button { Task { await submit() } } label: {
                    HStack(spacing: VL.Space.s3) {
                        if busy { ProgressView().tint(Color.vl.textSecondary) }
                        Text("login.submit")
                    }
                }
                .buttonStyle(.vlSolid)
                .disabled(busy || email.isEmpty || password.count < 8)
                Text("login.forgot").vlText(.label).foregroundStyle(Color.vl.textBrand).frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
            .padding(VL.Space.s5)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.vl.bgBase.ignoresSafeArea())
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

/// 01 · الإقلاع: علامة التطبيق واسمه وسطر الهوية، على خلفية الشاشة نفسها فلا يومض لون آخر قبل الدخول.
struct SplashView: View {
    var body: some View {
        VStack(spacing: VL.Space.s5) {
            AppMark(size: 120)
            Text("login.brand").vlText(.display).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.center)
            Text("splash.tagline").vlText(.body).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
        }
        .padding(VL.Space.s5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.vl.bgBase.ignoresSafeArea())
        .accessibilityElement(children: .combine)
    }
}
