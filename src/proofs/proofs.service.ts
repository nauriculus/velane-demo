import { Injectable } from "@nestjs/common";
import * as bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";
import {
  Rpc,
  createRpc,
  selectStateTreeInfo,
  sendAndConfirmTx,
} from "@lightprotocol/stateless.js";
import {
  compress,
  CompressedTokenProgram,
  getTokenPoolInfos,
  selectTokenPoolInfo,
} from "@lightprotocol/compressed-token";
import {
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  ExtensionType,
  LENGTH_SIZE,
  TYPE_SIZE,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  Connection,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createInitializeInstruction,
  pack,
  TokenMetadata,
} from "@solana/spl-token-metadata";
import { InitProofDto } from "./dto/init-proof.dto";
import { postgres_pool } from "../config/postgres.config";

const RPC_ENDPOINT = process.env.SOLANA_RPC!;
const connection: Rpc = createRpc(RPC_ENDPOINT, RPC_ENDPOINT);
const web3Connection = new Connection(RPC_ENDPOINT, "confirmed");

function loadPayer(): Keypair {
  const secret = process.env.PAYER_SECRET_BASE58;
  if (!secret) throw new Error("PAYER_SECRET_BASE58 missing");
  const arr = bs58.decode(secret);
  return Keypair.fromSecretKey(arr);
}

function loadMintAuthority(): Keypair {
  const secret = process.env.MASTER_MINT_AUTHORITY_SECRET_BASE58;
  if (!secret) throw new Error("MASTER_MINT_AUTHORITY_SECRET_BASE58 missing");
  const arr = bs58.decode(secret);
  return Keypair.fromSecretKey(arr);
}

@Injectable()
export class ProofsService {
  private async ensureTable() {
    const sql = `
      CREATE TABLE IF NOT EXISTS runtime_proofs (
        id SERIAL PRIMARY KEY,
        tx_signature TEXT NOT NULL,
        tx_bytes_base58 TEXT NOT NULL,
        runtime_proof_hash TEXT NOT NULL,
        user_id TEXT NOT NULL,
        runtime_id TEXT,
        timestamp_ms BIGINT NOT NULL,
        mint_address TEXT NOT NULL,
        mint_tx_id TEXT NOT NULL,
        compressed_tx_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_proofs_user ON runtime_proofs(user_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_proofs_tx ON runtime_proofs(tx_signature);
    `;
    await postgres_pool.query(sql);
  }

  async retrieveProofsByUser(userId: string) {
    await this.ensureTable();
    const q = `
      SELECT
        tx_signature AS "txSignature",
        tx_bytes_base58 AS "txBytesBase58",
        runtime_proof_hash AS "runtimeProofHash",
        user_id AS "userId",
        runtime_id AS "runtimeId",
        timestamp_ms AS "timestamp",
        mint_address AS "mint",
        mint_tx_id AS "mintTxId",
        compressed_tx_id AS "compressedTxId",
        chain,
        created_at AS "createdAt"
      FROM runtime_proofs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const res = await postgres_pool.query(q, [userId]);
    return { ok: true, proofs: res.rows } as any;
  }

  private recomputeRuntimeHash(
    txBytes: Uint8Array,
    timestamp: number,
    runtimeId?: string
  ) {
    const input = new Uint8Array([
      ...txBytes,
      ...new TextEncoder().encode(`|ts:${timestamp}|rid:${runtimeId ?? ""}`),
    ]);
    return Buffer.from(sha256(input)).toString("hex");
  }

  private async confirmTx(txSignature: string) {
    const rawConn = new Connection(RPC_ENDPOINT, "confirmed");
    return await rawConn.getTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
    });
  }

  async initAndMint(dto: InitProofDto) {
    const payer = loadPayer();

    const txInfo = await this.confirmTx(dto.txSignature);
    if (!txInfo) return { ok: false, error: "TX_NOT_FOUND" };

    let txBytes: Uint8Array;
    try {
      txBytes = bs58.decode(dto.txBytesBase58);
    } catch {
      return { ok: false, error: "INVALID_TX_BYTES_BASE58" };
    }
    const computed = this.recomputeRuntimeHash(
      txBytes,
      dto.timestamp,
      dto.runtimeId
    );
    if (computed !== dto.runtimeProofHash)
      return { ok: false, error: "RUNTIME_HASH_MISMATCH" };

    const activeStateTrees = await connection.getStateTreeInfos();
    const treeInfo = selectStateTreeInfo(activeStateTrees);

    let mintPublicKey: PublicKey;
    let mintTxId: string | null = null;
    let mintAuthority: Keypair | null = null;
    const masterMintEnv = process.env.MASTER_MINT_PUBKEY;
    if (masterMintEnv) {
      mintPublicKey = new PublicKey(masterMintEnv);
      // When using a pre-existing mint, we need its mint authority to MintTo
      try {
        mintAuthority = loadMintAuthority();
      } catch (e) {
        return { ok: false, error: "MINT_AUTHORITY_MISSING" } as any;
      }
    } else {
      const mint = Keypair.generate();
      mintPublicKey = mint.publicKey;
      const decimals = 0;
      const tokenMetadata: TokenMetadata = {
        mint: mint.publicKey,
        name: "RuntimeProof",
        symbol: "RTPRF",
        uri: "https://shardvell.com/proof/" + mint.publicKey,
        additionalMetadata: [
          ["txHash", dto.txSignature],
          ["runtimeProofHash", dto.runtimeProofHash],
          ["userId", dto.userId],
          ["timestamp", String(dto.timestamp)],
          ["runtimeId", dto.runtimeId ?? ""],
          ["chain", "solana"],
        ],
      };

      const mintLen = getMintLen([ExtensionType.MetadataPointer]);
      const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(tokenMetadata).length;
      const lamports = await connection.getMinimumBalanceForRentExemption(
        mintLen + metadataLen
      );

      const ixs = [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMetadataPointerInstruction(
          mint.publicKey,
          payer.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(
          mint.publicKey,
          decimals,
          payer.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          mint: mint.publicKey,
          metadata: mint.publicKey,
          name: tokenMetadata.name,
          symbol: tokenMetadata.symbol,
          uri: tokenMetadata.uri,
          mintAuthority: payer.publicKey,
          updateAuthority: payer.publicKey,
        }),
      ];

      const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const mintTx = new VersionedTransaction(messageV0);
      mintTx.sign([payer, mint]);
      try {
        mintTxId = await sendAndConfirmTx(connection, mintTx);
      } catch (e: any) {
        let logs: string[] | undefined;
        if (e && typeof e.getLogs === "function") {
          try {
            logs = await e.getLogs(web3Connection);
          } catch {}
        }
        return {
          ok: false,
          error: "MINT_TX_FAILED",
          message: e?.message ?? String(e),
          logs,
        } as any;
      }
    }

    let poolInfos = await getTokenPoolInfos(connection, mintPublicKey);
    let pool = selectTokenPoolInfo(poolInfos);
    if (!pool) {
      const createPoolIx = await CompressedTokenProgram.createTokenPool({
        feePayer: payer.publicKey,
        mint: mintPublicKey,
        tokenProgramId: TOKEN_2022_PROGRAM_ID,
      });
      const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [createPoolIx],
      }).compileToV0Message();
      const tx = new VersionedTransaction(messageV0);
      tx.sign([payer]);
      try {
        await sendAndConfirmTx(connection, tx);
      } catch (e: any) {
        let logs: string[] | undefined;
        if (e && typeof e.getLogs === "function") {
          try {
            logs = await e.getLogs(web3Connection);
          } catch {}
        }
        return {
          ok: false,
          error: "CREATE_POOL_FAILED",
          message: e?.message ?? String(e),
          logs,
        } as any;
      }
      poolInfos = await getTokenPoolInfos(connection, mintPublicKey);
      pool = selectTokenPoolInfo(poolInfos);
    }
    let compressedTxId: string;

    const amount = Math.max(1, Math.min(50, Number(dto.batchCount ?? 1)));
    const payerAta = getAssociatedTokenAddressSync(
      mintPublicKey,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    try {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerAta,
        payer.publicKey,
        mintPublicKey,
        TOKEN_2022_PROGRAM_ID
      );
      const mintIx = createMintToInstruction(
        mintPublicKey,
        payerAta,
        (mintAuthority ?? payer).publicKey,
        amount,
        [],
        TOKEN_2022_PROGRAM_ID
      );
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [createAtaIx, mintIx],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([payer, ...(mintAuthority ? [mintAuthority] : [])]);
      await sendAndConfirmTx(connection, tx);
    } catch (e: any) {
      // If ATA exists or mint already done, we can proceed; only rethrow for unexpected errors with logs
      try {
        const logs = await e?.getLogs?.(web3Connection);
        if (logs) {
          // swallow common "already in use" errors
          const joined = Array.isArray(logs) ? logs.join("\n") : String(logs);
          const isExpected =
            /already in use|custom program error: 0x0|Account already initialized/i.test(
              joined
            );
          if (!isExpected) {
            return {
              ok: false,
              error: "PREPARE_ATA_OR_MINT_FAILED",
              message: e?.message ?? String(e),
              logs,
            } as any;
          }
        }
      } catch {}
    }
    try {
      compressedTxId = await compress(
        connection,
        payer,
        mintPublicKey,
        amount,
        payer,
        payerAta,
        payer.publicKey,
        treeInfo,
        pool
      );
    } catch (e: any) {
      let logs: string[] | undefined;
      if (e && typeof e.getLogs === "function") {
        try {
          logs = await e.getLogs(web3Connection);
        } catch {}
      }
      return {
        ok: false,
        error: "COMPRESS_TX_FAILED",
        message: e?.message ?? String(e),
        logs,
      } as any;
    }

    try {
      const memoProgramId = new PublicKey(
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
      );
      const memoPayload = JSON.stringify({
        t: "rtp",
        m: mintPublicKey.toBase58(),
        c: compressedTxId,
        h: dto.runtimeProofHash,
      });
      const memoIx = new TransactionInstruction({
        keys: [],
        programId: memoProgramId,
        data: Buffer.from(memoPayload, "utf8"),
      });
      const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [memoIx],
      }).compileToV0Message();
      const memoTx = new VersionedTransaction(messageV0);
      memoTx.sign([payer]);
      await sendAndConfirmTx(connection, memoTx);
    } catch (_) {}

    await this.ensureTable();
    await postgres_pool.query(
      `INSERT INTO runtime_proofs (
        tx_signature, tx_bytes_base58, runtime_proof_hash, user_id, runtime_id, timestamp_ms,
        mint_address, mint_tx_id, compressed_tx_id, chain
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        dto.txSignature,
        dto.txBytesBase58,
        dto.runtimeProofHash,
        dto.userId,
        dto.runtimeId ?? null,
        dto.timestamp,
        mintPublicKey.toBase58(),
        mintTxId ?? "",
        compressedTxId,
        "solana",
      ]
    );

    return {
      ok: true,
      mint: mintPublicKey.toBase58(),
      mintTxId: mintTxId ?? "",
      compressedTxId,
      metadata: {
        txHash: dto.txSignature,
        runtimeProofHash: dto.runtimeProofHash,
        userId: dto.userId,
        timestamp: dto.timestamp,
        runtimeId: dto.runtimeId ?? "",
        chain: "solana",
      },
    };
  }

  async retrieveProofsByUser(userId: string) {
    await this.ensureTable();
    const q = `
      SELECT
        tx_signature AS "txSignature",
        tx_bytes_base58 AS "txBytesBase58",
        runtime_proof_hash AS "runtimeProofHash",
        user_id AS "userId",
        runtime_id AS "runtimeId",
        timestamp_ms AS "timestamp",
        mint_address AS "mint",
        mint_tx_id AS "mintTxId",
        compressed_tx_id AS "compressedTxId",
        chain,
        created_at AS "createdAt"
      FROM runtime_proofs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const res = await postgres_pool.query(q, [userId]);
    return { ok: true, proofs: res.rows } as any;
  }
}
