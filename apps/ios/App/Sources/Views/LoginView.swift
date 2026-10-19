import AuthCore
import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var app: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var totpCode = ""
    @State private var error: AuthError?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("login.email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("login.password", text: $password)
                        .textContentType(.password)
                    TextField("login.totp", text: $totpCode)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                } footer: {
                    Text("login.totp.help")
                }
                if let error {
                    Section { Text(error.messageKey).foregroundStyle(.red) }
                }
                Section {
                    Button { Task { await submit() } } label: {
                        if busy { ProgressView() } else { Text("login.submit") }
                    }
                    .disabled(busy || email.isEmpty || password.count < 8)
                }
            }
            .navigationTitle("login.title")
        }
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
