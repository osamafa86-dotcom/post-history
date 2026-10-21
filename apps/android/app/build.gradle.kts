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
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
