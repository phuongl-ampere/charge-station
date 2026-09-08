import { IsInt, IsString, MaxLength, Min } from "class-validator";

export class CreateOrderDto {
  @IsString()
  @MaxLength(64)
  connectorCode!: string;

  @IsInt()
  @Min(1)
  durationMinutes!: number;
}
