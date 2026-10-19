package net.palpost.library.upload

import android.content.Context
import android.net.Uri
import net.palpost.library.core.upload.FileSource
import java.io.FileNotFoundException
import java.io.InputStream

/** The picked file as a stream straight from its provider: no copy, no re-encode (package rule). */
class ContentResolverFileSource(private val context: Context) : FileSource {
    override fun open(uri: String): InputStream =
        context.contentResolver.openInputStream(Uri.parse(uri)) ?: throw FileNotFoundException("no stream for picked file")
}
