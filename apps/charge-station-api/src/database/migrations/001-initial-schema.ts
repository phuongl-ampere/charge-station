import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchemaMigration20260908000000 implements MigrationInterface {
  name = "InitialSchemaMigration20260908000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE SEQUENCE payos_order_code_seq
        START WITH 100000
        INCREMENT BY 1
        MINVALUE 1
    `);

    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email varchar NOT NULL UNIQUE,
        password_hash varchar NOT NULL,
        role varchar NOT NULL DEFAULT 'CUSTOMER',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE stations (
        id uuid PRIMARY KEY,
        code varchar NOT NULL UNIQUE,
        name varchar NOT NULL,
        device_id varchar,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE pricing_plans (
        id uuid PRIMARY KEY,
        name varchar NOT NULL UNIQUE,
        hourly_price_vnd integer NOT NULL,
        allowed_durations_minutes integer[] NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE connectors (
        id uuid PRIMARY KEY,
        code varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'AVAILABLE',
        station_id uuid NOT NULL REFERENCES stations(id),
        pricing_plan_id uuid REFERENCES pricing_plans(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE orders (
        id uuid PRIMARY KEY,
        payos_order_code bigint NOT NULL UNIQUE DEFAULT nextval('payos_order_code_seq'),
        duration_minutes integer NOT NULL,
        amount_vnd integer NOT NULL,
        currency varchar(3) NOT NULL DEFAULT 'VND',
        status varchar NOT NULL DEFAULT 'PENDING_PAYMENT',
        user_id uuid REFERENCES users(id),
        connector_id uuid NOT NULL REFERENCES connectors(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE payment_transactions (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
        provider varchar(16) NOT NULL DEFAULT 'PAYOS',
        payment_link_id varchar UNIQUE,
        checkout_url varchar,
        status varchar NOT NULL DEFAULT 'PENDING',
        raw_webhook_payload jsonb,
        signature_valid boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE charging_sessions (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
        connector_id uuid NOT NULL REFERENCES connectors(id),
        status varchar NOT NULL DEFAULT 'PENDING',
        started_at timestamptz,
        expected_end_at timestamptz,
        stopped_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE device_commands (
        id uuid PRIMARY KEY,
        command_id varchar NOT NULL UNIQUE,
        session_id uuid NOT NULL REFERENCES charging_sessions(id),
        command_type varchar(32) NOT NULL,
        payload jsonb NOT NULL,
        retry_count integer NOT NULL DEFAULT 0,
        status varchar NOT NULL DEFAULT 'PENDING',
        acknowledged_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE device_events (
        id uuid PRIMARY KEY,
        event_id varchar NOT NULL UNIQUE,
        session_id uuid REFERENCES charging_sessions(id),
        command_id uuid REFERENCES device_commands(id),
        device_id varchar NOT NULL,
        connector_code varchar NOT NULL,
        event_type varchar(32) NOT NULL,
        occurred_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        processed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE device_events");
    await queryRunner.query("DROP TABLE device_commands");
    await queryRunner.query("DROP TABLE charging_sessions");
    await queryRunner.query("DROP TABLE payment_transactions");
    await queryRunner.query("DROP TABLE orders");
    await queryRunner.query("DROP TABLE connectors");
    await queryRunner.query("DROP TABLE pricing_plans");
    await queryRunner.query("DROP TABLE stations");
    await queryRunner.query("DROP TABLE users");
    await queryRunner.query("DROP SEQUENCE payos_order_code_seq");
  }
}

export { InitialSchemaMigration20260908000000 as InitialSchemaMigration };
