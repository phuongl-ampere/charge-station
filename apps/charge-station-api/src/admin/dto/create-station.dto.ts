import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

const stationCodePattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export class CreateStationDto {
  @IsString()
  @MaxLength(60)
  @Matches(stationCodePattern)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;
}
