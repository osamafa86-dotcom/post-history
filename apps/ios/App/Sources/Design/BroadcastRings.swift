import SwiftUI

/// `Broadcast rings` من شعار الشبكة (design-system-v2.md «المبادئ» 3): تنبض أثناء الرفع، وتهدأ بانتظار الشبكة وفي حالات الفراغ،
/// وتمتلئ عند الوصول، وتحمرّ عند الفشل. مع «تقليل الحركة» يتوقف النبض والاحتفال وتبقى الدوائر والقوس والرقم والكلمة،
/// فالمعنى لا يحمله التحريك. زخرفية: النص في الوسط ووصف الحالة يضعهما من يستعملها ويقرؤهما قارئ الشاشة.
struct BroadcastRings: View {
    enum State: Equatable {
        /// يُرفع: القوس يتقدّم والدوائر تنبض.
        case uploading
        /// بانتظار الشبكة أو موقوف: القوس ثابت بلون التنبيه.
        case waiting
        /// وصل كل شيء: دائرة ممتلئة بعلامة ✓ واحتفال مرة واحدة.
        case done
        case failed
        /// فراغ أو شاشة حالة: دوائر ساكنة ونقطة.
        case calm
    }

    let state: State
    var fraction: Double = 0
    var diameter: CGFloat = 220
    /// لون بديل للدوائر (شاشات القفل والمسح بنغمتها).
    var tone: Color?
    var showsDot = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.State private var appeared = false

    /// أنصاف أقطار الدوائر الثلاث من الداخل إلى الخارج كنسبة من القطر (النموذج الحيّ: 62 و78 و94 من 100).
    private static let ringScales: [CGFloat] = [0.62, 0.78, 0.94]
    private static let restingOpacity: [Double] = [0.9, 0.5, 0.25]

    private var color: Color {
        if let tone { return tone }
        switch state {
        case .uploading, .done, .calm: return .vl.actionPrimary
        case .waiting: return .vl.stateWarn
        case .failed: return .vl.stateDanger
        }
    }

    private var pulsing: Bool { state == .uploading && !reduceMotion }

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !pulsing)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .stroke(color, lineWidth: VL.Border.ring)
                        .frame(width: diameter * Self.ringScales[i], height: diameter * Self.ringScales[i])
                        .scaleEffect(scale(ring: i, time: t))
                        .opacity(opacity(ring: i, time: t))
                        .animation(state == .done && !reduceMotion ? .easeOut(duration: 1.2).delay(0.15 * Double(i)) : nil, value: appeared)
                }
                center
            }
            .frame(width: diameter, height: diameter)
        }
        .onAppear {
            // الاحتفال مرة واحدة عند الظهور؛ مع «تقليل الحركة» تظهر الدوائر في موضعها مباشرة.
            appeared = true
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder private var center: some View {
        let inner = diameter * 0.46
        switch state {
        case .done:
            ZStack {
                Circle().fill(Color.vl.actionPrimary)
                Image(systemName: "checkmark")
                    .font(.system(size: inner * 0.32, weight: .bold))
                    .foregroundStyle(Color.vl.textOnBrand)
            }
            .frame(width: inner * 0.86, height: inner * 0.86)
            .scaleEffect(appeared || reduceMotion ? 1 : 0.6)
            .animation(reduceMotion ? nil : .spring(duration: 0.6, bounce: 0.35), value: appeared)
        case .calm:
            if showsDot {
                Circle().fill(color).frame(width: diameter * 0.17, height: diameter * 0.17)
            }
        case .uploading, .waiting, .failed:
            ZStack {
                Circle().stroke(Color.vl.bgSunken, lineWidth: VL.Border.progress)
                Circle()
                    .trim(from: 0, to: min(max(fraction, 0), 1))
                    .stroke(color, style: StrokeStyle(lineWidth: VL.Border.progress, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(reduceMotion ? nil : .linear(duration: VL.Duration.slow), value: fraction)
            }
            .frame(width: inner, height: inner)
            .environment(\.layoutDirection, .leftToRight)
        }
    }

    /// النبض: من 0.9 إلى 1.1 خلال `motion/pulse`، بتأخير 0.4 ث لكل دائرة إلى الخارج.
    private func phase(ring: Int, time: TimeInterval) -> Double {
        let period = VL.Duration.pulse
        let shifted = time - 0.4 * Double(ring)
        return (shifted.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period) / period
    }

    private func scale(ring: Int, time: TimeInterval) -> CGFloat {
        if pulsing { return 0.9 + 0.2 * phase(ring: ring, time: time) }
        if state == .done, !reduceMotion { return appeared ? 1 : 0.6 }
        return 1
    }

    private func opacity(ring: Int, time: TimeInterval) -> Double {
        if pulsing { return 0.8 * (1 - phase(ring: ring, time: time)) }
        if state == .done, !reduceMotion, !appeared { return 0 }
        return Self.restingOpacity[ring]
    }
}

/// علامة التطبيق: مربّع بالتدرّج (من الأماكن النادرة له مع زرّ الإرسال) وفيه دوائر البثّ ونقطتها، كأيقونة التطبيق.
struct AppMark: View {
    var size: CGFloat = 120

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .fill(LinearGradient(colors: [.vl.actionPrimary, .vl.actionGradientEnd], startPoint: .topLeading, endPoint: .bottomTrailing))
            Circle().stroke(Color.vl.textOnBrand.opacity(0.45), lineWidth: size * 0.025).frame(width: size * 0.64, height: size * 0.64)
            Circle().stroke(Color.vl.textOnBrand.opacity(0.85), lineWidth: size * 0.03).frame(width: size * 0.42, height: size * 0.42)
            Circle().fill(Color.vl.textOnBrand).frame(width: size * 0.16, height: size * 0.16)
        }
        .frame(width: size, height: size)
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }
}
