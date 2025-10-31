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
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  Connection,
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

    const mint = Keypair.generate();
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
      await CompressedTokenProgram.createTokenPool({
        feePayer: payer.publicKey,
        mint: mint.publicKey,
        tokenProgramId: TOKEN_2022_PROGRAM_ID,
      }),
    ];

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const mintTx = new VersionedTransaction(messageV0);
    mintTx.sign([payer, mint]);
    let mintTxId: string;
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

    const pool = selectTokenPoolInfo(
      await getTokenPoolInfos(connection, mint.publicKey)
    );
    let compressedTxId: string;
    try {
      compressedTxId = await compress(
        connection,
        payer,
        mint.publicKey,
        1,
        payer,
        new PublicKey(payer.publicKey),
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
        mint.publicKey.toBase58(),
        mintTxId,
        compressedTxId,
        "solana",
      ]
    );

    return {
      ok: true,
      mint: mint.publicKey.toBase58(),
      mintTxId,
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
}
