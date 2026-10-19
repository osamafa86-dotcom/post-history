# Models are read by Moshi through Kotlin reflection (KotlinJsonAdapterFactory): keep them and their metadata.
-keep class net.palpost.library.api.models.** { *; }
-keep class net.palpost.library.core.auth.SessionTokens { *; }
-keep class kotlin.Metadata { *; }
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
