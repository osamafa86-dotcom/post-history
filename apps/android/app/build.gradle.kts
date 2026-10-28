plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

android {
    namespace = "net.palpost.library"
    compileSdk = 36

    defaultConfig {
        applicationId = "net.palpost.library"
        minSdk = 29
        targetSdk = 36
        // appstore-release (play-* branches) sets APP_VERSION_CODE = version_code_base + its run number.
        versionCode = providers.environmentVariable("APP_VERSION_CODE").orNull?.toIntOrNull() ?: 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Upload key from the environment the release workflow provides (appstore-release, apps/<app>.yml android.env);
    // none locally, where a release build is left unsigned. The key never enters this repository.
    val keystorePath = providers.environmentVariable("APP_KEYSTORE").orNull
    signingConfigs {
        if (keystorePath != null) create("upload") {
            storeFile = file(keystorePath)
            storePassword = providers.environmentVariable("APP_KEYSTORE_PASSWORD").orNull
            keyAlias = providers.environmentVariable("APP_KEY_ALIAS").orNull ?: "upload"
            keyPassword = providers.environmentVariable("APP_KEYSTORE_PASSWORD").orNull
        }
    }

    // Base URL of the API (`/v1`): -PapiBaseUrl=… or the API_BASE_URL environment variable (the release workflow).
    // Debug builds point at the local compose stack otherwise; a release build must have an https URL (preReleaseBuild).
    val apiBaseUrl = providers.gradleProperty("apiBaseUrl").orElse(providers.environmentVariable("API_BASE_URL")).orNull
    // Firebase client settings for FCM (not secrets, but kept out of this public repository: the release workflow
    // passes them as -P or ORG_GRADLE_PROJECT_ variables). All four empty = no push; the notifications list still works.
    // The web app's origin, for the receipt's QR link to the material (A3). Optional: without it the QR is not shown.
    val webBaseUrl = providers.gradleProperty("webBaseUrl").orElse(providers.environmentVariable("WEB_BASE_URL")).orNull.orEmpty().trimEnd('/')
    defaultConfig.buildConfigField("String", "WEB_BASE_URL", "\"$webBaseUrl\"")
    for ((key, prop) in listOf("FCM_APP_ID" to "fcmAppId", "FCM_API_KEY" to "fcmApiKey", "FCM_PROJECT_ID" to "fcmProjectId", "FCM_SENDER_ID" to "fcmSenderId")) {
        defaultConfig.buildConfigField("String", key, "\"${project.findProperty(prop)?.toString().orEmpty()}\"")
    }
    // Google Cloud project linked to the app in Play Console (App integrity); Play Integrity standard requests
    // need it. Not a secret. 0 = no attester: sessions behind the ingest gate then fail as DEVICE_NOT_TRUSTED.
    val playCloudProjectNumber = project.findProperty("playCloudProjectNumber")?.toString()?.toLongOrNull() ?: 0L
    defaultConfig.buildConfigField("long", "PLAY_CLOUD_PROJECT_NUMBER", "${playCloudProjectNumber}L")
    buildTypes {
        debug {
            buildConfigField("String", "API_BASE_URL", "\"${apiBaseUrl ?: "http://10.0.2.2:3000/v1"}\"")
        }
        release {
            buildConfigField("String", "API_BASE_URL", "\"${apiBaseUrl ?: ""}\"")
            signingConfigs.findByName("upload")?.let { signingConfig = it }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
            freeCompilerArgs.add("-opt-in=androidx.compose.material3.ExperimentalMaterial3Api::class".removeSuffix("::class"))
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        // Every user-facing string must exist in both languages (CLAUDE.md §4.4).
        error += listOf("MissingTranslation", "ExtraTranslation")
        abortOnError = true
    }
}

/**
 * The design system's tokens (docs/design/tokens.json, owned by the design agent) as Kotlin for the Compose theme:
 * the semantic colours in both modes, spacing, radii, sizes, borders, type roles and motion. Generated at build
 * time, never copied by hand, so a token change reaches the app through this task alone (#387).
 */
abstract class GenerateDesignTokens : DefaultTask() {
    @get:InputFile abstract val tokens: RegularFileProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    @Suppress("UNCHECKED_CAST")
    fun run() {
        val root = groovy.json.JsonSlurper().parse(tokens.get().asFile, "UTF-8") as Map<String, Any?>
        val color = root["color"] as Map<String, Any?>
        val primitive = color["primitive"] as Map<String, Map<String, Map<String, Any?>>>
        val semantic = (color["semantic"] as Map<String, Map<String, Any?>>).filterKeys { !it.startsWith("$") }
        fun hex(ref: String): String {
            val v = if (ref.startsWith("{")) {
                val path = ref.trim('{', '}').split('.')
                require(path.size == 4 && path[0] == "color" && path[1] == "primitive") { "unsupported colour reference $ref" }
                primitive.getValue(path[2]).getValue(path[3])["\$value"] as String
            } else ref
            require(Regex("^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$").matches(v)) { "unsupported colour value $v" }
            val rgb = v.substring(1, 7).uppercase()
            val alpha = if (v.length == 9) v.substring(7, 9).uppercase() else "FF"
            return "0x$alpha$rgb"
        }
        fun ident(key: String): String {
            val parts = key.split('/', '-', '.', '_').filter { it.isNotEmpty() }
            return parts.first() + parts.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercaseChar) }
        }
        fun dp(v: Any?): String = (v as String).removeSuffix("px").let { if (it.toDouble() % 1.0 == 0.0) it.toDouble().toInt().toString() else it }
        fun group(name: String, prefix: String): String {
            val g = (root[name] as Map<String, Map<String, Any?>>).filterKeys { !it.startsWith("$") }
            return buildString {
                append("object Vl${name.replaceFirstChar(Char::uppercaseChar)} {\n")
                for ((k, v) in g) {
                    val id = ident(k).let { if (it.first().isDigit()) prefix + it else it }
                    append("    val $id = ${dp(v["\$value"])}.dp\n")
                }
                append("}\n")
            }
        }
        val out = StringBuilder()
        out.append("// Generated from docs/design/tokens.json by :app:generateDesignTokens. Do not edit.\n")
        out.append("package net.palpost.library.ui.theme.tokens\n\n")
        out.append("import androidx.compose.animation.core.CubicBezierEasing\nimport androidx.compose.animation.core.LinearEasing\n")
        out.append("import androidx.compose.ui.graphics.Color\nimport androidx.compose.ui.text.font.FontWeight\n")
        out.append("import androidx.compose.ui.unit.TextUnit\nimport androidx.compose.ui.unit.dp\nimport androidx.compose.ui.unit.sp\n\n")
        out.append("/** The semantic colours (`color.semantic.*`); one instance per mode. */\n")
        out.append("data class VlColors(\n")
        for (k in semantic.keys) out.append("    val ${ident(k)}: Color,\n")
        out.append(")\n\n")
        for (mode in listOf("light", "dark")) {
            out.append("val Vl${mode.replaceFirstChar(Char::uppercaseChar)}Colors = VlColors(\n")
            for ((k, v) in semantic) out.append("    ${ident(k)} = Color(${hex((v["\$value"] as Map<String, String>).getValue(mode))}),\n")
            out.append(")\n\n")
        }
        out.append(group("space", "s")).append("\n")
        out.append(group("radius", "r")).append("\n")
        out.append(group("size", "z")).append("\n")
        out.append(group("border", "b")).append("\n")
        val roles = ((root["font"] as Map<String, Any?>)["role"] as Map<String, Map<String, Any?>>).filterKeys { !it.startsWith("$") }
        out.append("/** Which family a type role draws from: the text face (Arabic and Latin), the display face, or the mono face. */\n")
        out.append("enum class VlFontKind { TEXT, DISPLAY, MONO }\n\n")
        out.append("data class VlTypeRole(val size: TextUnit, val lineHeight: TextUnit, val weight: FontWeight, val kind: VlFontKind)\n\n")
        out.append("object VlType {\n")
        for ((k, v) in roles) {
            val r = v["\$value"] as Map<String, Any?>
            val family = r["fontFamily"] as String
            val kind = if (family.contains("font.family.mono")) "MONO" else if (family.contains("font.family.display")) "DISPLAY" else "TEXT"
            out.append("    val ${ident(k)} = VlTypeRole(${dp(r["fontSize"])}.sp, ${dp(r["lineHeight"])}.sp, FontWeight(${r["fontWeight"]}), VlFontKind.$kind)\n")
        }
        out.append("}\n\n")
        val motion = root["motion"] as Map<String, Map<String, Map<String, Any?>>>
        out.append("object VlMotion {\n")
        for ((k, v) in motion.getValue("duration").filterKeys { !it.startsWith("$") }) out.append("    const val ${ident(k)}Ms = ${(v["\$value"] as String).removeSuffix("ms")}\n")
        for ((k, v) in motion.getValue("easing").filterKeys { !it.startsWith("$") }) {
            val value = v["\$value"] as String
            val easing = if (value == "linear") "LinearEasing" else "CubicBezierEasing(" + value.removePrefix("cubic-bezier(").removeSuffix(")").split(',').joinToString(", ") { it.trim() + "f" } + ")"
            out.append("    val ${ident(k)} = $easing\n")
        }
        out.append("}\n")
        val dir = outputDir.get().asFile
        dir.deleteRecursively()
        File(dir, "net/palpost/library/ui/theme/tokens").apply { mkdirs() }.resolve("DesignTokens.kt").writeText(out.toString(), Charsets.UTF_8)
    }
}

val generateDesignTokens by tasks.registering(GenerateDesignTokens::class) {
    description = "Generates the Compose design tokens from docs/design/tokens.json."
    tokens.set(layout.projectDirectory.file("../../../docs/design/tokens.json"))
    outputDir.set(layout.buildDirectory.dir("generated/designTokens"))
}

androidComponents {
    onVariants { variant -> variant.sources.java?.addGeneratedSourceDirectory(generateDesignTokens, GenerateDesignTokens::outputDir) }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    val url = providers.gradleProperty("apiBaseUrl").orElse(providers.environmentVariable("API_BASE_URL")).orElse("")
    doFirst {
        check(url.get().startsWith("https://")) { "Release builds need -PapiBaseUrl=https://<api host>/v1 or API_BASE_URL (got '${url.get()}')." }
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.zxing.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.play.integrity)
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:core-ktx:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
