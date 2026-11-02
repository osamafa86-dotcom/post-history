import MaterialsCore
import PostHistoryAPI
import SwiftUI

// مكوّنات الهوية v2 «إشارة» (docs/design/design-system-v2.md «المكوّنات»؛ ADR 0085 و0088) من الرموز المولَّدة وحدها؛
// لا قيم ألوان أو مسافات مكتوبة هنا. كل مكوّن: RTL أولًا، حجم الخط الديناميكي حتى أحجام الوصولية، هدف لمس ≥ 44،
// والحالة كلمة وأيقونة لا لون وحده.

// MARK: - النغمات

/// نغمات الحالات في v2 (`color.state.*`): لون وأيقونة.
enum VLTone: Equatable {
    case ok, warn, muted, brand, danger

    init(_ signal: MaterialStatus.SignalTone) {
        switch signal {
        case .ok: self = .ok
        case .warn: self = .warn
        case .muted: self = .muted
        case .brand: self = .brand
        case .danger: self = .danger
        }
    }

    var color: Color {
        switch self {
        case .ok: return .vl.stateOk
        case .warn: return .vl.stateWarn
        case .muted: return .vl.stateMuted
        case .brand: return .vl.stateBrand
        case .danger: return .vl.stateDanger
        }
    }
}

// MARK: - الأزرار

/// `Button`: Primary (تدرّج، لزرّ الإرسال وحده) · Solid (الإجراء الرئيسي) · Outline (الثانوي) × Large · Small.
/// الدور المدمّر يأخذ لون الخطر في Outline. المعطَّل سطح غائر ونص ثانوي مقروء، لأن نصّه قد يكون سبب التعطيل (ADR 0088).
struct VLButtonStyle: ButtonStyle {
    enum Kind { case primary, solid, outline }
    /// `hero`: زرّ «إرسال من الميدان» الكبير في الرئيسية وحده (03).
    enum Size { case hero, large, small }

    var kind: Kind
    var size: Size = .large
    var fullWidth = true
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
        let destructive = configuration.role == .destructive
        return configuration.label
            .vlText(size == .hero ? .title : .button)
            .multilineTextAlignment(.center)
            .foregroundStyle(foreground(destructive: destructive))
            .padding(.horizontal, size == .small ? VL.Space.s5 : VL.Space.s6)
            .padding(.vertical, VL.Space.s3)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: minHeight)
            .background { backdrop(shape) }
            .overlay {
                if kind == .outline {
                    shape.strokeBorder(destructive ? Color.vl.stateDanger : Color.vl.borderEdge, lineWidth: VL.Border.field)
                }
            }
            .opacity(configuration.isPressed ? 0.85 : 1)
            .contentShape(shape)
    }

    private var minHeight: CGFloat {
        switch size {
        case .hero: return VL.Space.s11 + VL.Space.s3
        case .large: return VL.Size.ctaMin
        case .small: return VL.Size.touchMin
        }
    }

    private func foreground(destructive: Bool) -> Color {
        guard isEnabled else { return .vl.textSecondary }
        switch kind {
        case .primary, .solid: return .vl.textOnBrand
        case .outline: return destructive ? .vl.stateDanger : .vl.textPrimary
        }
    }

    @ViewBuilder private func backdrop(_ shape: RoundedRectangle) -> some View {
        if !isEnabled, kind != .outline {
            shape.fill(Color.vl.bgSunken)
        } else {
            switch kind {
            case .primary:
                shape.fill(LinearGradient(colors: [.vl.actionPrimary, .vl.actionGradientEnd],
                                          startPoint: UnitPoint(x: 0, y: 0.3), endPoint: UnitPoint(x: 1, y: 0.7)))
            case .solid:
                shape.fill(Color.vl.actionPrimary)
            case .outline:
                shape.fill(Color.clear)
            }
        }
    }
}

/// زر نصّي بلا إطار (روابط وإجراءات ثانوية صغيرة)؛ هدف لمس ≥ 44، والمدمّر بلون الخطر.
struct VLGhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .vlText(.label)
            .frame(minHeight: VL.Size.touchMin)
            .padding(.horizontal, VL.Space.s3)
            .foregroundStyle(configuration.role == .destructive ? Color.vl.stateDanger : Color.vl.textBrand)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == VLButtonStyle {
    static var vlPrimary: VLButtonStyle { VLButtonStyle(kind: .primary) }
    static var vlSolid: VLButtonStyle { VLButtonStyle(kind: .solid) }
    static var vlOutline: VLButtonStyle { VLButtonStyle(kind: .outline) }
    static var vlOutlineSmall: VLButtonStyle { VLButtonStyle(kind: .outline, size: .small, fullWidth: false) }
}

extension ButtonStyle where Self == VLGhostButtonStyle { static var vlGhost: VLGhostButtonStyle { VLGhostButtonStyle() } }

/// زر أيقونة دائري 44×44 بسطح غائر (إغلاق، إعدادات، إشعارات)؛ عنوانه لقارئ الشاشة إلزامي.
struct VLIconButton: View {
    let systemImage: String
    let label: LocalizedStringKey
    var badge: Int = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.vl.textPrimary)
                .frame(width: VL.Size.touchMin, height: VL.Size.touchMin)
                .background(Color.vl.bgSunken, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Text(verbatim: badge > 99 ? "99+" : "\(badge)")
                            .vlText(.caption)
                            .foregroundStyle(Color.vl.textOnBrand)
                            .padding(.horizontal, VL.Space.s2)
                            .frame(minWidth: VL.Space.s6, minHeight: VL.Space.s6)
                            .background(Color.vl.priorityUrgent, in: Capsule())
                            .environment(\.layoutDirection, .leftToRight)
                            .offset(x: VL.Space.s2, y: -VL.Space.s2)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityValue(badge > 0 ? Text("a11y.unread \(badge)") : Text(verbatim: ""))
    }
}

// MARK: - البطاقة والحقول

/// سطح مرفوع بحدّ رفيع وزاوية `radius/md`.
struct VLCard<Content: View>: View {
    var padding: CGFloat = VL.Space.s5
    var border: Color = .vl.borderLine
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s4) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(border, lineWidth: VL.Border.hairline))
    }
}

/// صندوق `Text field`: ارتفاع ≥ `size/field-min`، حدّ `border/edge` 1.5 (≥ 3:1 ليُقرأ في الشمس)، وعند التركيز `action/primary` 2،
/// وعند الخطأ `state/danger` 2؛ والخطأ نصّ تحت الحقل لا لون وحده.
private struct VLInputBox: ViewModifier {
    var invalid: Bool
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var focused: Bool

    private var borderColor: Color {
        if invalid { return .vl.stateDanger }
        return focused ? .vl.actionPrimary : .vl.borderEdge
    }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
        return content
            .vlText(.body)
            .foregroundStyle(isEnabled ? Color.vl.textPrimary : Color.vl.textSecondary)
            .tint(Color.vl.actionPrimary)
            .focused($focused)
            .padding(.horizontal, VL.Space.s4)
            .padding(.vertical, VL.Space.s3)
            .frame(maxWidth: .infinity, minHeight: VL.Size.fieldMin, alignment: .leading)
            .background(isEnabled ? Color.vl.bgRaised : Color.vl.bgSunken, in: shape)
            .overlay(shape.strokeBorder(borderColor, lineWidth: invalid || focused ? VL.Border.field + 0.5 : VL.Border.field))
            .contentShape(shape)
            .onTapGesture { focused = true }
    }
}

extension View {
    /// يلبس حقل نص (`TextField` / `SecureField`) صندوق `Text field`.
    func vlInput(invalid: Bool = false) -> some View { modifier(VLInputBox(invalid: invalid)) }
}

/// عنوان حقل صغير (`label`) بلون ثانوي كما في إطارات الإرسال والدخول.
struct VLFieldLabel: View {
    let text: Text
    var isOptional = false

    var body: some View {
        HStack(spacing: VL.Space.s3) {
            text.vlText(.label).foregroundStyle(Color.vl.textSecondary)
            if isOptional { Text("form.optional").vlText(.caption).foregroundStyle(Color.vl.textSecondary) }
        }
    }
}

/// رسالة خطأ تحت حقل: أيقونة وكلمة، لا لون وحده.
struct VLFieldError: View {
    let text: Text

    var body: some View {
        Label { text.vlText(.caption) } icon: { Image(systemName: "exclamationmark.circle") }
            .foregroundStyle(Color.vl.stateDanger)
    }
}

/// حقل بعنوانه فوقه ونص مساعد أو خطأ تحته؛ الخطأ يستبدل المساعدة. عنوان قارئ الشاشة `a11yLabel` (العنوان المرئي افتراضيًا).
struct VLField<Content: View>: View {
    let label: Text
    var a11yLabel: Text?
    var isRequired = false
    var isOptional = false
    var help: Text?
    var error: Text?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            HStack(spacing: VL.Space.s2) {
                VLFieldLabel(text: label, isOptional: isOptional)
                if isRequired { Text(verbatim: "*").vlText(.label).foregroundStyle(Color.vl.stateDanger) }
            }
            .accessibilityHidden(true)
            content
                .vlInput(invalid: error != nil)
                .accessibilityLabel(a11yLabel ?? label)
            if let error {
                VLFieldError(text: error)
            } else if let help {
                help.vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - الرقائق

/// `Chip`: Default · Selected. المحدَّد بحبر داكن ووزن أثقل وسمة «محدَّد» لقارئ الشاشة، لا بلون وحده. ≥ 44×44.
struct VLChip: View {
    let label: Text
    let selected: Bool
    var minWidth: CGFloat = VL.Size.touchMin
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            label
                .vlText(selected ? .chipSelected : .chip)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .foregroundStyle(selected ? Color.vl.bgRaised : Color.vl.textPrimary)
                .padding(.horizontal, VL.Space.s4)
                .padding(.vertical, VL.Space.s2)
                .frame(minWidth: minWidth, minHeight: VL.Size.touchMin)
                .background(selected ? Color.vl.textPrimary : Color.vl.bgRaised,
                            in: RoundedRectangle(cornerRadius: VL.Radius.chip, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: VL.Radius.chip, style: .continuous)
                    .strokeBorder(selected ? Color.vl.textPrimary : Color.vl.borderEdge, lineWidth: VL.Border.field))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// `Filter chips`: اختيار واحد من مجموعة لها اسم لقارئ الشاشة؛ تلتفّ ولا تُقصّ.
struct VLFilterChips<Value: Hashable>: View {
    let groupLabel: LocalizedStringKey
    let options: [(value: Value, label: Text)]
    @Binding var selection: Value

    var body: some View {
        VLFlow(spacing: VL.Space.s3) {
            ForEach(options, id: \.value) { option in
                VLChip(label: option.label, selected: selection == option.value) { selection = option.value }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(groupLabel))
    }
}

/// تخطيط يلفّ العناصر إلى أسطر (رقائق ووسوم وشارات)، من بداية السطر في الاتجاهين.
struct VLFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = arrange(width: width, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = fitted(subviews[index], width: bounds.width)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    /// عنصر أعرض من السطر (وسم طويل بخط كبير) يُعطى عرض السطر فيلتفّ نصّه ولا يُقصّ.
    private func fitted(_ subview: LayoutSubview, width: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        guard width.isFinite, ideal.width > width else { return ideal }
        return subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = fitted(subviews[index], width: width)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width { rows.append(Row()) }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

// MARK: - الشارات

/// `State badge`: أيقونة وكلمة بنغمة (ok · warn · muted · brand · danger). قارئ الشاشة يقرأ «الحالة الفنية: جاهزة».
struct StateBadge: View {
    let labelKey: String
    let tone: VLTone
    var systemImage: String
    var trackKey: String?

    var body: some View {
        Label {
            Text(LocalizedStringKey(labelKey)).vlText(.caption)
        } icon: {
            Image(systemName: systemImage).imageScale(.small)
        }
        .labelStyle(VLCompactLabelStyle())
        .foregroundStyle(tone.color)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }

    private var accessibility: Text {
        guard let trackKey else { return Text(LocalizedStringKey(labelKey)) }
        return Text(LocalizedStringKey(trackKey)) + Text(verbatim: ": ") + Text(LocalizedStringKey(labelKey))
    }
}

/// أيقونة وكلمة متلاصقتان.
struct VLCompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VL.Space.s2) {
            configuration.icon
            configuration.title
        }
    }
}

extension MaterialStatus.Track {
    /// «الحالة الفنية» وأخواتها: بادئة قارئ الشاشة لكل شارة.
    var labelKey: String { "track.\(rawValue)" }

    /// أيقونة كل نغمة في مسارها (design-system-v2.md): فنية (✓ جاهزة، ساعة تُعالَج، تنبيه فشلت) · تحريرية (قلم قيد المراجعة،
    /// ✓ معتمدة، ✕ مرفوضة) · حقوق (ساعة داخلي، مفتاح للعرض، قفل مقيّد).
    func systemImage(_ tone: VLTone) -> String {
        switch (self, tone) {
        case (_, .ok): return "checkmark"
        case (.technical, .danger): return "exclamationmark.triangle"
        case (_, .danger): return "xmark.circle"
        case (.editorial, _): return "pencil"
        case (.rights, .brand): return "key"
        case (.rights, .warn): return "lock"
        default: return "clock"
        }
    }
}

/// الشارات الثلاث مستقلة بالترتيب فنية → تحريرية → حقوق، كلٌّ بأيقونته وكلمته؛ تلتفّ ولا تُقصّ.
struct ThreeStateBadges: View {
    let status: MaterialStatus
    var axis: Axis = .vertical
    var onSelect: ((MaterialStatus.Track) -> Void)?

    var body: some View {
        if axis == .vertical {
            VStack(alignment: .leading, spacing: VL.Space.s1) { badges }
        } else {
            VLFlow(spacing: VL.Space.s4) { badges }
        }
    }

    @ViewBuilder private var badges: some View {
        ForEach(MaterialStatus.Track.allCases, id: \.self) { track in badge(track) }
    }

    @ViewBuilder private func badge(_ track: MaterialStatus.Track) -> some View {
        let b = status.badge(track)
        let tone = VLTone(MaterialStatus.signalTone(b.tone, track: track))
        let view = StateBadge(labelKey: b.labelKey, tone: tone, systemImage: track.systemImage(tone), trackKey: track.labelKey)
        if let onSelect {
            Button { onSelect(track) } label: { view.frame(minHeight: VL.Size.touchMin) }
                .buttonStyle(.plain)
                .accessibilityHint(Text("timeline.filter.hint"))
        } else {
            view
        }
    }
}

/// شارة الأولوية: «عاجل» بلون العاجل وأيقونة البرق، و«مهم» بالتنبيه؛ «عادي» لا شارة له.
struct PriorityBadge: View {
    let priority: Priority

    var body: some View {
        switch priority {
        case .urgent:
            StateBadge(labelKey: "material.priority.urgent", tone: .danger, systemImage: "bolt.fill")
        case .important:
            StateBadge(labelKey: "material.priority.important", tone: .warn, systemImage: "exclamationmark")
        default:
            EmptyView()
        }
    }
}

// MARK: - الملاحظات والفراغ

/// سطر ملاحظة على سطح غائر: أيقونة بنغمة ونص (حالة الرفع، الانقطاع، تنبيه حقل). النبرة بالأيقونة والنص لا بالخلفية.
struct VLNote: View {
    let tone: VLTone
    let systemImage: String
    let text: Text
    var actionKey: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack(alignment: .firstTextBaseline, spacing: VL.Space.s3) {
                Image(systemName: systemImage).foregroundStyle(tone.color).accessibilityHidden(true)
                text.vlText(.body).foregroundStyle(Color.vl.textPrimary).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let actionKey, let action {
                Button(actionKey, action: action).buttonStyle(.vlOutline)
            }
        }
        .padding(.horizontal, VL.Space.s4)
        .padding(.vertical, VL.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.vl.bgSunken, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// `Empty state`: دوائر هادئة، وعنوان يقول ما سيظهر وكيف، وإجراء اختياري.
struct VLEmptyState<Action: View>: View {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    @ViewBuilder var action: Action

    var body: some View {
        VStack(spacing: VL.Space.s4) {
            BroadcastRings(state: .calm, fraction: 0, diameter: 96)
                .accessibilityHidden(true)
            Text(title).vlText(.headline).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.center)
            Text(message).vlText(.body).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
            action.padding(.top, VL.Space.s4)
        }
        .padding(.vertical, VL.Space.s8)
        .frame(maxWidth: .infinity)
    }
}

extension VLEmptyState where Action == EmptyView {
    init(title: LocalizedStringKey, message: LocalizedStringKey) {
        self.title = title
        self.message = message
        self.action = EmptyView()
    }
}

/// دائرة أيقونة بنغمة لشاشات الحالة الكاملة (قفل، إبطال الجلسة، المسح)؛ زخرفية فلا يقرؤها قارئ الشاشة.
struct VLHeroIcon: View {
    let systemImage: String
    let tone: VLTone

    var body: some View {
        ZStack {
            BroadcastRings(state: .calm, fraction: 0, diameter: 136, tone: tone.color, showsDot: false)
            Circle().fill(Color.vl.bgRaised).frame(width: 72, height: 72)
            Circle().strokeBorder(tone.color, lineWidth: VL.Border.field).frame(width: 72, height: 72)
            Image(systemName: systemImage).font(.system(size: 30, weight: .semibold)).foregroundStyle(tone.color)
        }
        .frame(width: 136, height: 136)
        .accessibilityHidden(true)
    }
}

/// عنوان قسم (`label`) يعلنه قارئ الشاشة عنوانًا.
struct VLSectionHeader: View {
    let key: LocalizedStringKey
    init(_ key: LocalizedStringKey) { self.key = key }

    var body: some View {
        Text(key).vlText(.label).foregroundStyle(Color.vl.textSecondary).accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// خلفية الشاشة `bg/base` وعرض أقصى 560 على الشاشات العريضة.
    func vlScreen() -> some View {
        frame(maxWidth: 560).frame(maxWidth: .infinity).background(Color.vl.bgBase.ignoresSafeArea())
    }
}

/// غلاف نمط زر يسمح باختيار النمط في الوقت التشغيلي.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
