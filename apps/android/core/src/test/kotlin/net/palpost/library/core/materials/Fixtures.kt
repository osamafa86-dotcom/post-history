package net.palpost.library.core.materials

import net.palpost.library.api.models.DisplayName
import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.api.models.RightsState
import net.palpost.library.api.models.Sensitivity
import net.palpost.library.api.models.TechnicalState
import java.time.OffsetDateTime
import java.util.UUID

/** Neutral sample materials for the tests. */
internal object Fixtures {
    val t0: OffsetDateTime = OffsetDateTime.parse("2026-11-02T10:00:00Z")

    fun id(n: Int): UUID = UUID.fromString("00000000-0000-0000-0000-%012d".format(n))

    fun file(n: Int, kind: MaterialFile.Kind, state: MaterialFile.State = MaterialFile.State.verified, sha: String? = null, mime: String? = null,
             at: OffsetDateTime = t0, duration: Long? = null, proxyMode: MaterialFile.ProxyMode? = null) =
        MaterialFile(id = id(1000 + n), kind = kind, state = state, createdAt = at, sha256 = sha, mimeType = mime, durationMs = duration, proxyMode = proxyMode)

    fun material(
        n: Int, title: String = "Sample title $n", at: OffsetDateTime = t0.plusMinutes(n.toLong()), files: List<MaterialFile> = emptyList(),
        sensitive: Boolean = false, types: Set<MaterialType> = setOf(MaterialType.report), priority: Priority = Priority.normal,
        editorial: EditorialState = EditorialState.inbox, technical: TechnicalState = TechnicalState.pending,
    ) = Material(
        title = title, materialTypes = types, governorate = "G", city = "C", priority = priority,
        sensitivity = Sensitivity(minors = sensitive, injured = false, graphic = false), displayName = DisplayName(DisplayName.Mode.real_name),
        formVersion = 1, dynamicFields = emptyMap(), id = id(n), version = 1, reporterId = id(999), officeId = null,
        technicalState = technical, editorialState = editorial, rightsState = RightsState.unknown, files = files, createdAt = at, updatedAt = at,
    )
}
