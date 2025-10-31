import {
  Body,
  Controller,
  Post,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { InitProofDto } from "./dto/init-proof.dto";
import { ProofsService } from "./proofs.service";

@Controller("proofs")
export class ProofsController {
  constructor(private readonly proofs: ProofsService) {}

  @Post("init")
  async init(@Body() dto: InitProofDto) {
    if (!dto || typeof dto !== "object") {
      throw new BadRequestException({ ok: false, error: "INVALID_BODY" });
    }
    const required = [
      "txSignature",
      "txBytesBase58",
      "runtimeProofHash",
      "timestamp",
      "userId",
    ] as const;
    for (const key of required) {
      if ((dto as any)[key] === undefined || (dto as any)[key] === null) {
        throw new BadRequestException({ ok: false, error: `MISSING_${key}` });
      }
    }
    try {
      const result = await this.proofs.initAndMint(dto);
      return result;
    } catch (e: any) {
      throw new InternalServerErrorException({
        ok: false,
        error: "INTERNAL",
        details: e?.message ?? String(e),
      });
    }
  }
}
