package net.palpost.library.core.net

import java.util.UUID

/** One key per operation, generated once and reused on every retry of that operation (contract rule). */
object IdempotencyKey {
    fun generate(): String = UUID.randomUUID().toString()
}
