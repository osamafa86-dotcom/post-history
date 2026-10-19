import FormEngine
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// راسم النموذج الديناميكي من `UploadForm` (مخطط upload-form.json): الأنواع العشرة، الرؤية بالشرط ونوع المادة، والأخطاء بالدلالات المشتركة.
struct DynamicFormView: View {
    let form: UploadForm
    let materialType: String
    @Binding var values: [String: FormValue]
    let errors: [FieldError]

    private var isArabic: Bool { Locale.current.language.languageCode?.identifier == "ar" }
    private func text(_ l: UploadFormLocalized) -> String { isArabic ? l.ar : l.en }

    var body: some View {
        ForEach(FormValidator.visibleFields(form: form, materialType: materialType, values: values), id: \.key) { field in
            VStack(alignment: .leading, spacing: 4) {
                FieldControl(field: field, label: text(field.label), optionLabel: text, value: binding(field.key))
                if let help = field.help { Text(text(help)).font(.caption).foregroundStyle(.secondary) }
                if let error = errors.first(where: { $0.field == field.key }) {
                    Text(error.code.labelKey).font(.caption).foregroundStyle(.red)
                }
            }
        }
    }

    private func binding(_ key: String) -> Binding<FormValue> {
        Binding(get: { values[key] ?? .null }, set: { values[key] = $0 })
    }
}

private struct FieldControl: View {
    let field: UploadFormField
    let label: String
    let optionLabel: (UploadFormLocalized) -> String
    @Binding var value: FormValue
    @State private var showAttachmentPicker = false

    private var title: Text { Text(label) + (field.required ? Text(" *").foregroundColor(.red) : Text("")) }

    var body: some View {
        switch field.type {
        case .shortText:
            TextField(text: stringBinding) { title }
        case .longText:
            TextField(text: stringBinding, axis: .vertical) { title }.lineLimit(3...8)
        case .number:
            TextField(text: numberBinding) { title }.keyboardType(.decimalPad)
        case .select:
            Picker(selection: stringBinding) {
                Text("form.select.none").tag("")
                ForEach(field.validation?.options ?? [], id: \.value) { Text(optionLabel($0.label)).tag($0.value) }
            } label: { title }
        case .multiSelect:
            title
            ForEach(field.validation?.options ?? [], id: \.value) { option in
                Toggle(optionLabel(option.label), isOn: multiBinding(option.value))
            }
        case .datetime:
            DatePicker(selection: dateBinding) { title }
        case .boolean:
            Toggle(isOn: Binding(get: { value.boolValue ?? false }, set: { value = .bool($0) })) { title }
        case .staffMember:
            TextField(text: stringBinding) { title }.textInputAutocapitalization(.never).autocorrectionDisabled()
        case .attachment:
            // قيمة التحقق `[{mime, size_bytes}]`؛ الشكل النهائي لإرسال ملفات المرفق في dynamic_fields من اختصاص العقد.
            HStack {
                title
                Spacer()
                Button("form.attachment.add") { showAttachmentPicker = true }
            }
            Text("form.attachment.count \(value.arrayValue?.count ?? 0)").font(.caption).foregroundStyle(.secondary)
                .fileImporter(isPresented: $showAttachmentPicker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    guard case .success(let urls) = result else { return }
                    var items = value.arrayValue ?? []
                    for url in urls {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.doubleValue ?? 0
                        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                        items.append(.object(["mime": .string(mime), "size_bytes": .number(size)]))
                    }
                    value = .array(items)
                }
        case .location, .unknownDefaultOpenApi:
            // غير مسموح في نماذج v0 (بوابة الخادم)؛ نوع تفاعل جديد يحتاج إصدارًا من التطبيق.
            Label("form.field.unsupported", systemImage: "lock").foregroundStyle(.secondary)
        }
    }

    private var stringBinding: Binding<String> {
        Binding(get: { value.stringValue ?? "" }, set: { value = $0.isEmpty ? .null : .string($0) })
    }

    private var numberBinding: Binding<String> {
        Binding(get: { value.numberValue.map { $0 == $0.rounded() ? String(Int64($0)) : String($0) } ?? (value.stringValue ?? "") },
                set: { text in value = text.isEmpty ? .null : Double(text).map(FormValue.number) ?? .string(text) })
    }

    private func multiBinding(_ option: String) -> Binding<Bool> {
        Binding(get: { value.arrayValue?.contains(.string(option)) ?? false },
                set: { on in
                    var items = (value.arrayValue ?? []).filter { $0 != .string(option) }
                    if on { items.append(.string(option)) }
                    value = .array(items)
                })
    }

    private var dateBinding: Binding<Date> {
        let formatter = ISO8601DateFormatter()
        return Binding(get: { value.stringValue.flatMap(formatter.date(from:)) ?? Date() },
                       set: { value = .string(formatter.string(from: $0)) })
    }
}

extension FieldErrorCode {
    var labelKey: LocalizedStringKey {
        switch self {
        case .required: return "form.error.required"
        case .type: return "form.error.type"
        case .minLength: return "form.error.min_length"
        case .maxLength: return "form.error.max_length"
        case .pattern: return "form.error.pattern"
        case .min: return "form.error.min"
        case .max: return "form.error.max"
        case .option: return "form.error.option"
        case .minItems: return "form.error.min_items"
        case .maxItems: return "form.error.max_items"
        case .notBefore: return "form.error.not_before"
        case .notAfter: return "form.error.not_after"
        case .accept: return "form.error.accept"
        case .maxSizeBytes: return "form.error.max_size_bytes"
        }
    }
}
