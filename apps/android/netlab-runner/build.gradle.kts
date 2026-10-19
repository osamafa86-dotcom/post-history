// JVM entry point that drives the app's UploadEngine against the netlab stack (tools/netlab): the same
// transfer code the phone runs, measured on CI without an emulator. Not shipped in the app.
plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

application {
    mainClass.set("net.palpost.library.netlab.MainKt")
    applicationName = "netlab-runner"
}

dependencies {
    implementation(project(":core"))
    implementation(libs.kotlinx.coroutines.core)
}
