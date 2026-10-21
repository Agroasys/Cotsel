describe('local PostgreSQL harness resource ownership', () => {
  const prior = process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES;
  afterEach(() => {
    if (prior === undefined) delete process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES;
    else process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES = prior;
    jest.dontMock('pg');
    jest.resetModules();
  });
  async function setup(database: boolean, role: boolean) {
    process.env.GATEWAY_TEST_USE_LOCAL_POSTGRES = 'true';
    const admin = {
      query: jest.fn(async (_sql: string) => ({ rows: [{ database, role }] })),
      end: jest.fn(async () => {}),
      connect: jest.fn(async () => ({ query: jest.fn(async () => ({})), release: jest.fn() })),
    };
    jest.doMock('pg', () => ({ Pool: jest.fn(() => admin) }));
    let run!: typeof import('./helpers/governancePostgresHarness').withGovernancePostgres;
    await jest.isolateModulesAsync(async () => {
      run = (await import('./helpers/governancePostgresHarness')).withGovernancePostgres;
    });
    return { admin, run };
  }
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'preserves existing database=%s and role=%s when refusing a local run',
    async (database, role) => {
      const f = await setup(database, role);
      const body = jest.fn(async () => {});
      await expect(f.run(body)).rejects.toThrow('refusing to overwrite');
      expect(body).not.toHaveBeenCalled();
      expect(f.admin.query).toHaveBeenCalledTimes(1);
      expect(f.admin.query.mock.calls.flat().join('\n')).not.toMatch(
        /DROP|CREATE|terminate_backend/,
      );
      expect(f.admin.end).toHaveBeenCalledTimes(1);
    },
  );
  it('drops only its new role when database creation fails before ownership is acquired', async () => {
    const f = await setup(false, false);
    f.admin.query.mockImplementation(async (sql) => {
      if (sql === 'CREATE DATABASE gateway_test') throw new Error('controlled creation failure');
      return { rows: [{ database: false, role: false }] };
    });
    await expect(f.run(async () => {})).rejects.toThrow('controlled creation failure');
    const sql = f.admin.query.mock.calls.flat().join('\n');
    expect(sql).toContain('DROP ROLE IF EXISTS gateway_runtime');
    expect(sql).not.toContain('DROP DATABASE');
    expect(sql).not.toContain('terminate_backend');
    expect(f.admin.end).toHaveBeenCalledTimes(1);
  });
  it('cleans its own database and role when an isolated test fails', async () => {
    const f = await setup(false, false);
    await expect(
      f.run(async () => {
        throw new Error('controlled test failure');
      }),
    ).rejects.toThrow('controlled test failure');
    const sql = f.admin.query.mock.calls.flat().join('\n');
    expect(sql).toContain('CREATE DATABASE gateway_test');
    expect(sql).toContain('DROP DATABASE IF EXISTS gateway_test');
    expect(sql).toContain('DROP ROLE IF EXISTS gateway_runtime');
    expect(sql).toContain('pg_terminate_backend');
  });
});
