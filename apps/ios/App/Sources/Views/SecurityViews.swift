import DeviceSecurity
import SwiftUI

/// شاشة حالة كاملة بالهوية v2: دائرة أيقونة بنغمة داخل دوائر هادئة، وعنوان بخط العرض، ونص، وإجراء Solid.
struct VLStatusScreen<Content: View>: View {
    let systemImage: String
    let tone: VLTone
    let title: LocalizedStringKey
    var message: LocalizedStringKey?
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: VL.Space.s5) {
                VLHeroIcon(systemImage: systemImage, tone: tone).padding(.top, VL.Space.s10)
                Text(title).vlText(.title).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                if let message {
                    Text(message).vlText(.body).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
                }
                content
            }
            .padding(VL.Space.s5)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Color.vl.bgBase.ignoresSafeArea())
    }
}

/// شاشة «أُبطلت الجلسة»: مُحي على الهاتف كل ما يمحوه المسح الطارئ (ADR 0113)؛ لا تفاصيل عن السبب (قد يكون المشرف بعد بلاغ فقد
/// الهاتف). خطوات المسح لا تُعرض إلا إن تعذّرت إحداها، فيعرف المراسل ما بقي.
struct SessionRevokedView: View {
    @EnvironmentObject private var app: AppModel
    let report: WipeReport

    var body: some View {
        VLStatusScreen(systemImage: "lock.slash", tone: .danger, title: "revoked.title", message: "revoked.body") {
            if !report.allClean {
                Text("wipe.partial").vlText(.headline).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.center)
                WipeOutcomesCard(report: report)
            }
            Button("revoked.signInAgain") { app.acknowledgeAndSignIn() }.buttonStyle(.vlSolid)
        }
    }
}

/// بعد المسح الطارئ: ما مُسح وما تعذّر (أسماء خطوات لا مسارات)، ثم شاشة البداية.
struct WipedView: View {
    @EnvironmentObject private var app: AppModel
    let report: WipeReport

    var body: some View {
        VLStatusScreen(systemImage: report.allClean ? "checkmark.shield" : "exclamationmark.shield",
                       tone: report.allClean ? .ok : .warn, title: report.allClean ? "wipe.done" : "wipe.partial") {
            WipeOutcomesCard(report: report)
            Button("wipe.continue") { app.acknowledgeAndSignIn() }.buttonStyle(.vlSolid)
        }
    }
}

/// خطوات المسح بأسمائها (مفاتيح `wipe.step.*` في الموارد، لا مسارات) وحالة كلٍّ منها.
struct WipeOutcomesCard: View {
    let report: WipeReport

    var body: some View {
        VLCard {
            ForEach(report.outcomes, id: \.step) { outcome in
                HStack(spacing: VL.Space.s3) {
                    // المفتاح نصٌّ كامل لا إقحام فيه (`LocalizedStringKey("x.\(y)")` يصير مفتاحًا بصيغة %@ لا يوجد).
                    Text(LocalizedStringKey("wipe.step." + outcome.step)).vlText(.body).foregroundStyle(Color.vl.textPrimary)
                    Spacer(minLength: VL.Space.s3)
                    switch outcome.status {
                    case .wiped:
                        StateBadge(labelKey: "wipe.status.wiped", tone: .ok, systemImage: "checkmark")
                    case .absent:
                        StateBadge(labelKey: "wipe.status.absent", tone: .muted, systemImage: "minus")
                    case .failed:
                        StateBadge(labelKey: "wipe.status.failed", tone: .danger, systemImage: "xmark")
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// زر المسح الطارئ بتأكيد صريح (نافذة تأكيد ثم زر مدمّر).
struct EmergencyWipeButton: View {
    @EnvironmentObject private var app: AppModel
    @State private var confirm = false

    var body: some View {
        Button(role: .destructive) { confirm = true } label: { Label("wipe.action", systemImage: "trash.slash") }
            .confirmationDialog("wipe.confirm.title", isPresented: $confirm, titleVisibility: .visible) {
                Button("wipe.confirm.yes", role: .destructive) { Task { await app.emergencyWipe() } }
                Button("wipe.confirm.no", role: .cancel) {}
            } message: { Text("wipe.confirm.body") }
    }
}
