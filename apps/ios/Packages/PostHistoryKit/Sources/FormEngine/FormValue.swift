import Foundation
import PostHistoryAPI

/// قيمة حقل ديناميكي كما تُدخل وتُرسل في `dynamic_fields` (JSON حر). المرفق قيمته `[{mime, size_bytes}]` للتحقق.
public enum FormValue: Equatable, Sendable, Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([FormValue])
    case object([String: FormValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .number(Double(i)) }
        else if let d = try? c.decode(Double.self) { self = .number(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([FormValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: FormValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let d): if d == d.rounded(), abs(d) < 1e15 { try c.encode(Int64(d)) } else { try c.encode(d) }
        case .bool(let b): try c.encode(b)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }

    public init(_ json: JSONValue) {
        switch json {
        case .string(let s): self = .string(s)
        case .int(let i): self = .number(Double(i))
        case .double(let d): self = .number(d)
        case .bool(let b): self = .bool(b)
        case .array(let a): self = .array(a.map(FormValue.init))
        case .dictionary(let d): self = .object(d.mapValues(FormValue.init))
        case .null: self = .null
        }
    }

    public var jsonValue: JSONValue {
        switch self {
        case .string(let s): return .string(s)
        case .number(let d): return d == d.rounded() && abs(d) < 1e15 ? .int(Int(d)) : .double(d)
        case .bool(let b): return .bool(b)
        case .array(let a): return .array(a.map(\.jsonValue))
        case .object(let o): return .dictionary(o.mapValues(\.jsonValue))
        case .null: return .null
        }
    }

    /// «الفارغ» في دلالات التحقق المشتركة: غائب أو null أو "" أو مصفوفة فارغة. `false` قيمة موجودة.
    public var isEmpty: Bool {
        switch self {
        case .null: return true
        case .string(let s): return s.isEmpty
        case .array(let a): return a.isEmpty
        default: return false
        }
    }

    public var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    public var numberValue: Double? { if case .number(let d) = self { return d } else { return nil } }
    public var arrayValue: [FormValue]? { if case .array(let a) = self { return a } else { return nil } }
}
