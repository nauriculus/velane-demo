import { Body, Controller, Post } from "@nestjs/common";
import { InitProofDto } from "./dto/init-proof.dto";
import { ProofsService } from "./proofs.service";

@Controller("proofs")
export class ProofsController {
  constructor(private readonly proofs: ProofsService) {}

  @Post("init")
  async init(@Body() dto: InitProofDto) {
    return await this.proofs.initAndMint(dto);
  }
}
