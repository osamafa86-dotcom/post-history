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
    implementation(libs.play.integrity)
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
