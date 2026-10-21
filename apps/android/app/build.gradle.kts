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
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Base URL of the API (`/v1`). Debug builds point at the local compose stack unless -PapiBaseUrl=… says
    // otherwise; a release build must be given an https URL explicitly (checked in preReleaseBuild below).
    val apiBaseUrl = project.findProperty("apiBaseUrl")?.toString()
    // Firebase client settings for FCM (not secrets, but kept out of this public repository: the release workflow
    // passes them as -P or ORG_GRADLE_PROJECT_ variables). All four empty = no push; the notifications list still works.
    for ((key, prop) in listOf("FCM_APP_ID" to "fcmAppId", "FCM_API_KEY" to "fcmApiKey", "FCM_PROJECT_ID" to "fcmProjectId", "FCM_SENDER_ID" to "fcmSenderId")) {
        defaultConfig.buildConfigField("String", key, "\"${project.findProperty(prop)?.toString().orEmpty()}\"")
    }
    buildTypes {
        debug {
            buildConfigField("String", "API_BASE_URL", "\"${apiBaseUrl ?: "http://10.0.2.2:3000/v1"}\"")
        }
        release {
            buildConfigField("String", "API_BASE_URL", "\"${apiBaseUrl ?: ""}\"")
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

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    val url = providers.gradleProperty("apiBaseUrl").orElse("")
    doFirst {
        check(url.get().startsWith("https://")) { "Release builds need -PapiBaseUrl=https://<api host>/v1 (got '${url.get()}')." }
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
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
