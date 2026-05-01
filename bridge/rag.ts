import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  buildLocalEmbedding,
  cosineSimilarity,
  parseEmbedding,
  serializeEmbedding
} from '@bridge/embeddings';
import type { DatabaseManager } from '@bridge/db/database';
import type {
  ContextSource,
  KnowledgeDocument,
  MessageAttachment
} from '@bridge/ipc/contracts';
import { contextSourceSchema, knowledgeDocumentSchema } from '@bridge/ipc/contracts';
import type { Logger } from 'pino';

const MAX_CHUNK_CHARACTERS = 900;
const CHUNK_OVERLAP_CHARACTERS = 120;
const MIN_SEMANTIC_MATCH_SCORE = 0.12;

function nowIso() {
  return new Date().toISOString();
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replaceAll('"', '""'))
    .filter((token) => token.length >= 3);

  if (tokens.length === 0) {
    return '""';
  }

  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function hashContent(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
}

function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let currentChunk = '';

  const flush = () => {
    const candidate = currentChunk.trim();

    if (candidate) {
      chunks.push(candidate);
    }

    currentChunk = '';
  };

  const appendParagraph = (paragraph: string) => {
    if (!currentChunk) {
      currentChunk = paragraph;
      return;
    }

    const candidate = `${currentChunk}\n\n${paragraph}`;

    if (candidate.length <= MAX_CHUNK_CHARACTERS) {
      currentChunk = candidate;
      return;
    }

    flush();
    currentChunk = paragraph;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_CHARACTERS) {
      appendParagraph(paragraph);
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      if (sentence.length <= MAX_CHUNK_CHARACTERS) {
        appendParagraph(sentence);
        continue;
      }

      flush();

      for (
        let index = 0;
        index < sentence.length;
        index += MAX_CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS
      ) {
        const slice = sentence.slice(index, index + MAX_CHUNK_CHARACTERS).trim();

        if (slice) {
          chunks.push(slice);
        }
      }
    }
  }

  flush();
  return chunks;
}

function clampSearchScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}

function lexicalRankToScore(rank: number | null): number {
  if (rank === null || !Number.isFinite(rank)) {
    return 0;
  }

  return clampSearchScore(1 / (1 + Math.abs(rank)));
}

interface KnowledgeDocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  source_path: string | null;
  mime_type: string | null;
  token_estimate: number | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  source_path: string | null;
  snippet: string | null;
  content: string;
  score: number | null;
}

interface EmbeddingSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  source_path: string | null;
  content: string;
  vector_json: string;
}

interface MissingEmbeddingRow {
  chunk_id: string;
  workspace_id: string;
  content: string;
}

interface RankedKnowledgeCandidate {
  chunkId: string;
  documentId: string;
  title: string;
  sourcePath: string | null;
  excerpt: string;
  score: number;
}

export class RagService {
  private ensuredWorkspaces = new Set<string>();

  constructor(
    private readonly database: DatabaseManager,
    private readonly logger: Logger
  ) {}

  isReady(): boolean {
    return true;
  }

  hasWorkspaceKnowledge(workspaceId: string): boolean {
    const row = this.database.connection
      .prepare(`
        SELECT 1
        FROM knowledge_documents
        WHERE workspace_id = ?
        LIMIT 1
      `)
      .get(workspaceId) as { 1: number } | undefined;

    return Boolean(row);
  }

  hasDocumentPath(filePath: string): boolean {
    const row = this.database.connection
      .prepare(`
        SELECT 1
        FROM knowledge_documents
        WHERE source_path = ?
        LIMIT 1
      `)
      .get(filePath) as { 1: number } | undefined;

    return Boolean(row);
  }

  listWorkspaceDocuments(workspaceId: string): KnowledgeDocument[] {
    const rows = this.database.connection
      .prepare(`
        SELECT
          id,
          workspace_id,
          title,
          source_path,
          mime_type,
          token_estimate,
          created_at,
          updated_at
        FROM knowledge_documents
        WHERE workspace_id = ?
        ORDER BY updated_at DESC, title ASC
      `)
      .all(workspaceId) as unknown as KnowledgeDocumentRow[];

    return rows.map((row) =>
      knowledgeDocumentSchema.parse({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        sourcePath: row.source_path,
        mimeType: row.mime_type,
        tokenEstimate: row.token_estimate,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }

  importAttachments(
    workspaceId: string,
    attachments: MessageAttachment[]
  ): {
    documents: KnowledgeDocument[];
    skippedFiles: string[];
  } {
    this.assertWorkspaceExists(workspaceId);

    const documents: KnowledgeDocument[] = [];
    const skippedFiles: string[] = [];
    const importedAt = nowIso();

    const insertDocument = this.database.connection.prepare(`
      INSERT INTO knowledge_documents (
        id, workspace_id, title, source_path, mime_type,
        content_hash, token_estimate, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunk = this.database.connection.prepare(`
      INSERT INTO knowledge_chunks (
        id, document_id, workspace_id, chunk_index,
        content, content_hash, token_estimate, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteBySourcePath = this.database.connection.prepare(`
      DELETE FROM knowledge_documents
      WHERE workspace_id = ? AND source_path = ?
    `);

    for (const attachment of attachments) {
      const content = attachment.extractedText?.trim();

      if (!content) {
        skippedFiles.push(attachment.fileName);
        continue;
      }

      const contentHash = hashContent(content);
      const existingDocumentId = this.findDocumentIdByHash(workspaceId, contentHash);

      if (existingDocumentId) {
        const updatedDocument = this.updateExistingDocument(
          existingDocumentId,
          attachment,
          content
        );
        documents.push(updatedDocument);
        continue;
      }

      const documentId = randomUUID();
      const chunks = chunkText(content);
      const tokenEstimate = estimateTokens(content);

      this.database.connection.exec('BEGIN');

      try {
        if (attachment.filePath) {
          deleteBySourcePath.run(workspaceId, attachment.filePath);
        }

        insertDocument.run(
          documentId,
          workspaceId,
          attachment.fileName,
          attachment.filePath,
          attachment.mimeType,
          contentHash,
          tokenEstimate,
          importedAt,
          importedAt
        );

        chunks.forEach((chunk, index) => {
          const chunkId = randomUUID();

          insertChunk.run(
            chunkId,
            documentId,
            workspaceId,
            index,
            chunk,
            hashContent(chunk),
            estimateTokens(chunk),
            importedAt
          );
          this.upsertChunkEmbedding(chunkId, workspaceId, chunk, importedAt);
        });

        this.database.connection.exec('COMMIT');
      } catch (error) {
        this.database.connection.exec('ROLLBACK');
        throw error;
      }

      documents.push(
        knowledgeDocumentSchema.parse({
          id: documentId,
          workspaceId,
          title: attachment.fileName,
          sourcePath: attachment.filePath,
          mimeType: attachment.mimeType,
          tokenEstimate,
          createdAt: importedAt,
          updatedAt: importedAt
        })
      );
    }

    if (documents.length > 0 || skippedFiles.length > 0) {
      this.ensuredWorkspaces.delete(workspaceId);
      this.logger.info(
        {
          workspaceId,
          importedCount: documents.length,
          skippedCount: skippedFiles.length
        },
        'Processed workspace knowledge import'
      );
    }

    return {
      documents,
      skippedFiles
    };
  }

  searchWorkspaceKnowledge(workspaceId: string, query: string, limit = 4): ContextSource[] {
    if (!query.trim()) {
      return [];
    }

    this.ensureWorkspaceEmbeddings(workspaceId);

    const lexicalCandidates = this.getLexicalCandidates(workspaceId, query, limit);
    const semanticCandidates = this.getSemanticCandidates(workspaceId, query, limit);
    const mergedCandidates = new Map<string, RankedKnowledgeCandidate>();

    for (const candidate of [...lexicalCandidates, ...semanticCandidates]) {
      const existingCandidate = mergedCandidates.get(candidate.chunkId);

      if (!existingCandidate || candidate.score > existingCandidate.score) {
        mergedCandidates.set(candidate.chunkId, candidate);
      } else if (existingCandidate.excerpt.length < candidate.excerpt.length) {
        existingCandidate.excerpt = candidate.excerpt;
      }
    }

    const dedupedExcerpts = new Set<string>();
    const rankedSources = [...mergedCandidates.values()]
      .sort((left, right) => right.score - left.score)
      .filter((candidate) => {
        if (!candidate.excerpt || dedupedExcerpts.has(candidate.excerpt)) {
          return false;
        }

        dedupedExcerpts.add(candidate.excerpt);
        return true;
      })
      .slice(0, limit);

    return rankedSources.map((candidate) =>
      contextSourceSchema.parse({
        id: randomUUID(),
        kind: 'document_chunk',
        label: candidate.title,
        excerpt: candidate.excerpt,
        sourcePath: candidate.sourcePath,
        documentId: candidate.documentId,
        score: candidate.score
      })
    );
  }

  private getLexicalCandidates(
    workspaceId: string,
    query: string,
    limit: number
  ): RankedKnowledgeCandidate[] {
    const ftsQuery = buildFtsQuery(query);
    const rows = this.database.connection
      .prepare(`
        SELECT
          knowledge_chunks.id AS chunk_id,
          knowledge_documents.id AS document_id,
          knowledge_documents.title AS title,
          knowledge_documents.source_path AS source_path,
          snippet(knowledge_chunks_fts, 4, '', '', ' ... ', 18) AS snippet,
          knowledge_chunks.content AS content,
          bm25(knowledge_chunks_fts) AS score
        FROM knowledge_chunks_fts
        JOIN knowledge_chunks ON knowledge_chunks.id = knowledge_chunks_fts.chunk_id
        JOIN knowledge_documents ON knowledge_documents.id = knowledge_chunks.document_id
        WHERE knowledge_chunks_fts MATCH ?
          AND knowledge_documents.workspace_id = ?
        ORDER BY bm25(knowledge_chunks_fts) ASC
        LIMIT ?
      `)
      .all(ftsQuery, workspaceId, Math.max(limit * 3, limit)) as unknown as KnowledgeSearchRow[];

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      sourcePath: row.source_path,
      excerpt: (row.snippet ?? row.content).trim(),
      score: clampSearchScore(lexicalRankToScore(row.score) * 0.72)
    }));
  }

  private getSemanticCandidates(
    workspaceId: string,
    query: string,
    limit: number
  ): RankedKnowledgeCandidate[] {
    const queryEmbedding = buildLocalEmbedding(query);
    const rows = this.database.connection
      .prepare(`
        SELECT
          knowledge_chunks.id AS chunk_id,
          knowledge_documents.id AS document_id,
          knowledge_documents.title AS title,
          knowledge_documents.source_path AS source_path,
          knowledge_chunks.content AS content,
          knowledge_chunk_embeddings.vector_json AS vector_json
        FROM knowledge_chunk_embeddings
        JOIN knowledge_chunks ON knowledge_chunks.id = knowledge_chunk_embeddings.chunk_id
        JOIN knowledge_documents ON knowledge_documents.id = knowledge_chunks.document_id
        WHERE knowledge_chunk_embeddings.workspace_id = ?
        ORDER BY knowledge_chunk_embeddings.updated_at DESC
        LIMIT ?
      `)
      .all(workspaceId, Math.max(limit * 10, 100)) as unknown as EmbeddingSearchRow[];

    return rows
      .map((row) => ({
        row,
        similarity: clampSearchScore(
          Math.max(0, cosineSimilarity(queryEmbedding, parseEmbedding(row.vector_json)))
        )
      }))
      .filter((candidate) => candidate.similarity >= MIN_SEMANTIC_MATCH_SCORE)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, Math.max(limit * 3, limit))
      .map(({ row, similarity }) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        sourcePath: row.source_path,
        excerpt: row.content.trim(),
        score: clampSearchScore(similarity * 0.58)
      }));
  }

  private ensureWorkspaceEmbeddings(workspaceId: string): void {
    if (this.ensuredWorkspaces.has(workspaceId)) {
      return;
    }

    const missingRows = this.database.connection
      .prepare(`
        SELECT
          knowledge_chunks.id AS chunk_id,
          knowledge_chunks.workspace_id AS workspace_id,
          knowledge_chunks.content AS content
        FROM knowledge_chunks
        LEFT JOIN knowledge_chunk_embeddings
          ON knowledge_chunk_embeddings.chunk_id = knowledge_chunks.id
        WHERE knowledge_chunks.workspace_id = ?
          AND knowledge_chunk_embeddings.chunk_id IS NULL
        LIMIT 1000
      `)
      .all(workspaceId) as unknown as MissingEmbeddingRow[];

    if (missingRows.length === 0) {
      this.ensuredWorkspaces.add(workspaceId);
      return;
    }

    const timestamp = nowIso();

    for (const row of missingRows) {
      this.upsertChunkEmbedding(row.chunk_id, row.workspace_id, row.content, timestamp);
    }

    this.logger.info(
      {
        workspaceId,
        backfilledChunkCount: missingRows.length
      },
      'Backfilled missing local knowledge embeddings'
    );
  }

  private upsertChunkEmbedding(
    chunkId: string,
    workspaceId: string,
    content: string,
    timestamp = nowIso()
  ): void {
    this.database.connection
      .prepare(`
        INSERT INTO knowledge_chunk_embeddings (
          chunk_id,
          workspace_id,
          embedding_model,
          dimensions,
          vector_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          embedding_model = excluded.embedding_model,
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at
      `)
      .run(
        chunkId,
        workspaceId,
        LOCAL_EMBEDDING_MODEL,
        DEFAULT_EMBEDDING_DIMENSIONS,
        serializeEmbedding(buildLocalEmbedding(content)),
        timestamp,
        timestamp
      );
  }

  private assertWorkspaceExists(workspaceId: string) {
    const row = this.database.connection
      .prepare(`
        SELECT 1
        FROM workspaces
        WHERE id = ?
        LIMIT 1
      `)
      .get(workspaceId) as { 1: number } | undefined;

    if (!row) {
      throw new Error(`Workspace ${workspaceId} was not found.`);
    }
  }

  private findDocumentIdByHash(workspaceId: string, contentHash: string): string | null {
    const row = this.database.connection
      .prepare(`
        SELECT id
        FROM knowledge_documents
        WHERE workspace_id = ?
          AND content_hash = ?
        LIMIT 1
      `)
      .get(workspaceId, contentHash) as { id: string } | undefined;

    return row?.id ?? null;
  }

  private updateExistingDocument(
    documentId: string,
    attachment: MessageAttachment,
    content: string
  ): KnowledgeDocument {
    const updatedAt = nowIso();
    const tokenEstimate = estimateTokens(content);

    this.database.connection
      .prepare(`
        UPDATE knowledge_documents
        SET title = ?, source_path = ?, mime_type = ?, token_estimate = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        attachment.fileName,
        attachment.filePath,
        attachment.mimeType,
        tokenEstimate,
        updatedAt,
        documentId
      );

    const row = this.database.connection
      .prepare(`
        SELECT
          id,
          workspace_id,
          title,
          source_path,
          mime_type,
          token_estimate,
          created_at,
          updated_at
        FROM knowledge_documents
        WHERE id = ?
      `)
      .get(documentId) as KnowledgeDocumentRow | undefined;

    if (!row) {
      throw new Error(`Knowledge document ${documentId} was not found after update.`);
    }

    return knowledgeDocumentSchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      sourcePath: row.source_path,
      mimeType: row.mime_type,
      tokenEstimate: row.token_estimate,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}
