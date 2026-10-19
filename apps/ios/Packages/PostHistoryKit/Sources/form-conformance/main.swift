// يشغّل حالات المطابقة المشتركة على مدقّق iOS ويكتب ios.json لمقارنته بـ tools/acceptance/form-conformance/run.mjs --compare.
//   swift run form-conformance <cases.json> <out.json>
// يُكتب JSON يدويًا لأن run.mjs يقارن النص بعد JSON.stringify بترتيب المفاتيح {field, code}، وJSONEncoder على Linux لا يضمن الترتيب.
import FormEngine
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write(Data("usage: form-conformance <cases.json> <out.json>\n".utf8))
    exit(2)
}
let (output, mismatches) = try ConformanceSuite.run(casesFile: URL(fileURLWithPath: args[1]))
func quote(_ s: String) -> String { String(decoding: try! JSONEncoder().encode(s), as: UTF8.self) }
let results = output.results.keys.sorted().map { id -> String in
    let r = output.results[id]!
    let errors = r.errors.map { "{\"field\":\(quote($0.field)),\"code\":\(quote($0.code.rawValue))}" }.joined(separator: ",")
    return "  \(quote(id)): {\"valid\": \(r.valid), \"errors\": [\(errors)]}"
}.joined(separator: ",\n")
try Data("{\"platform\": \"ios\", \"results\": {\n\(results)\n}}\n".utf8).write(to: URL(fileURLWithPath: args[2]))
mismatches.forEach { print("MISMATCH \($0)") }
print("ios: \(output.results.count - mismatches.count)/\(output.results.count) cases match expectations")
exit(mismatches.isEmpty ? 0 : 1)
