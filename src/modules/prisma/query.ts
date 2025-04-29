import { PrismaClient } from '@prisma/client';

export function messagesQuery(prisma: PrismaClient, { clientId, operatorId, consultationId }) {
  return prisma.$queryRaw`
    SELECT DISTINCT m.id           AS "id",
                m.content      AS "content",
                m."chat_id"    AS "chatId",
                m."created_at" AS "createdAt",
                m."updated_at" AS "updatedAt",
                m.type         AS "type",
                m.rate         AS "rate",
                m.call_duration AS "callDuration",
                CASE
                    WHEN a.id IS NULL AND a.firstname IS NULL AND a.lastname IS NULL AND a."user_id" IS NULL AND
                         a."doctor_id" IS NULL THEN NULL
                    ELSE jsonb_build_object(
                            'id', a.id,
                            'firstname', a.firstname,
                            'lastname', a.lastname,
                            'userId', a."user_id",
                            'doctorId', a."doctor_id"
                         )
                    END        AS "author",
                CASE
                    WHEN ad.id IS NULL AND ad."org_id" IS NULL AND ad."is_deleted" IS NULL AND
                         ad."file_path" IS NULL AND ad."first_name" IS NULL AND ad."last_name" IS NULL THEN NULL
                    ELSE jsonb_build_object(
                            'id', ad.id,
                            'orgId', ad."org_id",
                            'isDeleted', ad."is_deleted",
                            'filePath', ad."file_path",
                            'firstname', ad."first_name",
                            'lastname', ad."last_name",
                            'specialties', (SELECT jsonb_agg(specialty)
                                          FROM (SELECT *
                                                FROM doctor.specialties
                                                WHERE id = ANY (ad.specialty_ids)
                                                  and ad.is_deleted is false) AS specialty)
                         )
                    END        AS "acceptDoctor",
                CASE
                    WHEN rm.id IS NULL AND rm."chat_id" IS NULL AND rm.file_id IS NULL THEN NULL
                    ELSE jsonb_build_object(
                            'id', rm.id,
                            'chatId', rm."chat_id",
                            'file', rm.file_id
                         )
                    END        AS "repliedMessage",
                to_jsonb(f.*)  AS "file",
                to_jsonb(tr.*) as transaction
FROM chat.message AS m
         JOIN chat.chat as ch on ch.id = m.chat_id and ch.is_deleted is false
         LEFT JOIN chat."user" AS a ON m."author_id" = a.id and a.is_deleted is false
         LEFT JOIN doctor.doctors AS ad ON m."accept_doctor_id" = ad.id and ad.is_deleted is false
         LEFT JOIN chat.message AS rm ON m."replied_message_id" = rm.id and rm.is_deleted is false
         LEFT JOIN consultation.transactions as tr on tr.id::text = m.transaction_id::text 
         LEFT JOIN file.files AS f ON m."file_id" = f.id and f.is_deleted is false
WHERE m."is_deleted" = FALSE
  and ch.consultation_id = ${consultationId}
  AND m."chat_id" IN (SELECT c.id
                      FROM chat.chat AS c
                      WHERE c."client_id" = ${clientId}
                         OR c."operator_id" = ${operatorId})
ORDER BY m."created_at" ASC;
    `;
}

export async function existDoctorInfo(prisma: PrismaClient, doctorId: string) {
  const [data]: any[] = await prisma.$queryRaw`
        select d.id,
               d.sip,
               d.sip_password,
              json_agg(s.*) filter ( where s.id is not null ) as specialties
        from doctor.doctors as d
                left join doctor.specialties as s on s.id = any (d.specialty_ids) and s.is_deleted is false
        where d.id = ${doctorId} and d.is_deleted is false
        group by d.id
        limit 1
  `;

  return data;
}
