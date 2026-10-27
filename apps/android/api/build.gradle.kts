// API client generated from the frozen contract (contracts/openapi.yaml). No hand-written models live here.
//
// The generator reads a "client view" of the contract produced by PrepareContractView: the YAML and the
// JSON schemas re-emitted as JSON after three mechanical relaxations the Kotlin generator cannot model.
// Nothing is added and no shape changes; the dropped constructs are publish-time constraints the server
// enforces, and the client re-implements the form rules in :core (FormValidator), judged by
// tools/acceptance/form-conformance/cases.json.
import groovy.json.JsonOutput
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml

buildscript {
    dependencies { classpath("org.yaml:snakeyaml:2.7") }
}

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.openapi.generator)
}

/**
 * Relaxations, applied to every document:
 *  1. `allOf` members that are constraint blocks rather than shapes (an `if`/`then`/`else` block, or a member
 *     with neither `$ref` nor `type`, such as the v0 gate) are dropped: the generator turns a schema that
 *     has them into an untyped map.
 *  2. `const` is dropped (the generator emits a one-value enum of the wrong kind for `const: true`).
 *  3. A `type` listing more than one non-null JSON type is dropped, so the property becomes `Any` rather
 *     than the first listed type.
 *  4. A component schema that is a `oneOf` of local object `$ref`s (with or without a `discriminator`) becomes
 *     one object with the union of their properties, of which only those every member requires stay required.
 *     The generator otherwise emits an interface that no member implements (`IngestTokenRequest`), so no
 *     request can be built. The client fills the members of one variant; Moshi omits the null rest.
 *  5. تعداد رقمي يبقى رقمًا: مولّد Kotlin يصدر enum بوسوم Json نصية يرفض Moshi قراءتها من JSON رقمي صحيح.
 *     نحذف enum الرقمي من منظور العميل وحده، وتبقى قيمه المسموحة شرطًا في عقد الخادم.
 */
abstract class PrepareContractView : DefaultTask() {
    @get:InputFile abstract val openapi: RegularFileProperty
    @get:InputDirectory abstract val schemas: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        File(out, "schemas").mkdirs()
        val yaml = Yaml(LoaderOptions().apply { codePointLimit = 16 * 1024 * 1024 })
        val spec = openapi.get().asFile.reader(Charsets.UTF_8).use { yaml.load<Any?>(it) }
        File(out, "openapi.json").writeText(emit(flattenOneOf(relax(spec))), Charsets.UTF_8)
        schemas.get().asFile.listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }.forEach { src ->
            val doc = src.reader(Charsets.UTF_8).use { yaml.load<Any?>(it) }
            File(out, "schemas/${src.name}").writeText(emit(relax(doc)), Charsets.UTF_8)
        }
    }

    private fun emit(node: Any?): String = JsonOutput.prettyPrint(JsonOutput.toJson(node))

    @Suppress("UNCHECKED_CAST")
    private fun flattenOneOf(spec: Any?): Any? {
        val schemas = ((spec as? Map<String, Any?>)?.get("components") as? Map<String, Any?>)?.get("schemas") as? MutableMap<String, Any?>
            ?: return spec
        val prefix = "#/components/schemas/"
        for ((name, value) in schemas.entries.toList()) {
            val schema = value as? Map<String, Any?> ?: continue
            val members = (schema["oneOf"] as? List<*>)?.map { (it as? Map<*, *>)?.get("\$ref") as? String } ?: continue
            if (members.any { it == null || !it.startsWith(prefix) }) continue
            val shapes = members.map { schemas[it!!.removePrefix(prefix)] as? Map<String, Any?> }
            if (shapes.any { it == null || it["type"] != "object" }) continue
            val properties = LinkedHashMap<String, Any?>()
            shapes.forEach { properties.putAll((it!!["properties"] as? Map<String, Any?>).orEmpty()) }
            val required = shapes.map { ((it!!["required"] as? List<*>).orEmpty()).toSet() }.reduce { a, b -> a intersect b }
            val flat = LinkedHashMap(schema)
            flat.remove("oneOf"); flat.remove("discriminator")
            flat["type"] = "object"
            flat["properties"] = properties
            flat["required"] = properties.keys.filter { it in required }
            schemas[name] = flat
        }
        return spec
    }

    @Suppress("UNCHECKED_CAST")
    private fun relax(node: Any?): Any? = when (node) {
        is Map<*, *> -> {
            val m = LinkedHashMap(node as Map<String, Any?>)
            val allOf = m["allOf"]
            if (allOf is List<*>) {
                val kept = allOf.filterNot { it is Map<*, *> && (it.containsKey("if") || (!it.containsKey("\$ref") && !it.containsKey("type"))) }
                if (kept.isEmpty()) m.remove("allOf") else m["allOf"] = kept
            }
            m.remove("const")
            val type = m["type"]
            val numeric = type == "integer" || type == "number" ||
                (type is List<*> && type.filter { it != "null" }.singleOrNull() in listOf("integer", "number"))
            val choices = m["enum"]
            if (numeric && choices is List<*> && choices.isNotEmpty() && choices.all { it is Number }) m.remove("enum")
            if (type is List<*> && type.count { it != "null" } > 1) m.remove("type")
            m.mapValuesTo(LinkedHashMap()) { relax(it.value) }
        }
        is List<*> -> node.map { relax(it) }
        else -> node
    }
}

val contractsDir = layout.projectDirectory.dir("../../../contracts")
val contractView = layout.buildDirectory.dir("contract-view")
val generatedDir = layout.buildDirectory.dir("generated/openapi")

val prepareContractView by tasks.registering(PrepareContractView::class) {
    description = "Re-emits contracts/ as JSON with the relaxations the Kotlin generator needs."
    openapi.set(contractsDir.file("openapi.yaml"))
    schemas.set(contractsDir.dir("schemas"))
    outputDir.set(contractView)
}

openApiGenerate {
    generatorName.set("kotlin")
    library.set("jvm-okhttp4")
    inputSpec.set(contractView.map { it.file("openapi.json").asFile.absolutePath })
    outputDir.set(generatedDir.map { it.asFile.absolutePath })
    packageName.set("net.palpost.library.api")
    apiPackage.set("net.palpost.library.api.apis")
    modelPackage.set("net.palpost.library.api.models")
    invokerPackage.set("net.palpost.library.api.infrastructure")
    // Byte counts in the contract are plain `integer`; files exceed 2 GiB, so every integer becomes Long.
    typeMappings.set(mapOf("integer" to "kotlin.Long"))
    inlineSchemaNameMappings.set(
        mapOf(
            "UploadForm_fields_inner" to "UploadFormField",
            "UploadForm_fields_inner_label" to "LocalizedText",
            "UploadForm_fields_inner_condition" to "FieldCondition",
            "UploadForm_fields_inner_validation" to "FieldValidation",
            "UploadForm_fields_inner_validation_options_inner" to "FieldOption",
            "UploadSession_tus_metadata" to "TusMetadata",
            "UploadSessionCreate_client_fingerprint" to "ClientFingerprint",
        ),
    )
    configOptions.set(
        mapOf(
            "serializationLibrary" to "moshi",
            "useCoroutines" to "true",
            "dateLibrary" to "java8",
            "omitGradleWrapper" to "true",
            "enumPropertyNaming" to "original",
        ),
    )
    generateApiTests.set(false)
    generateModelTests.set(false)
    generateApiDocumentation.set(false)
    generateModelDocumentation.set(false)
    // Sources only: the generator's own build files, README and manifest are not part of this module.
    globalProperties.set(
        mapOf(
            "apis" to "",
            "models" to "",
            "supportingFiles" to "ApiClient.kt,ApiAbstractions.kt,ApiResponse.kt,Errors.kt,PartConfig.kt,RequestConfig.kt,RequestMethod.kt,ResponseExtensions.kt,Serializer.kt,BigDecimalAdapter.kt,BigIntegerAdapter.kt,ByteArrayAdapter.kt,LocalDateAdapter.kt,LocalDateTimeAdapter.kt,OffsetDateTimeAdapter.kt,URIAdapter.kt,UUIDAdapter.kt",
        ),
    )
}

tasks.openApiGenerate {
    dependsOn(prepareContractView)
    // The plugin only tracks the spec file; the schemas it references through $ref must invalidate it too.
    inputs.dir(contractView)
    cleanupOutput.set(true)
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
    sourceSets["main"].kotlin.srcDir(generatedDir.map { it.dir("src/main/kotlin") })
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.named("compileKotlin") { dependsOn(tasks.openApiGenerate) }

dependencies {
    api(libs.okhttp)
    api(libs.moshi.kotlin)
    api(libs.moshi.adapters)
    api(libs.kotlinx.coroutines.core)
}
