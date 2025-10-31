export class InitProofDto {
  txSignature!: string;
  txBytesBase58!: string;
  runtimeProofHash!: string;
  timestamp!: number;
  runtimeId?: string;
  userId!: string;
  batchCount?: number;
}
