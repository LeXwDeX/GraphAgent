import { NO_USEFUL_REASONING_TEXT } from "@opencode-ai/core/session/reasoning-distillation"

/** Fixed-fixture semantic checks for the opt-in live acceptance harness. Not a production judge. */
export function checkFixtureSemantics(id: string, texts: string[]): Record<string, boolean> {
  const clean = (value: string) =>
    value
      .replace(/[`*_#]/g, "")
      .replace(/\s+/g, "")
      .replace(/[：]/g, ":")
  const text = clean(texts.join("\n"))
  const segment = (value: string, start: string, end?: string) => {
    const from = value.indexOf(start)
    if (from < 0) return ""
    const to = end ? value.indexOf(end, from + start.length) : -1
    return value.slice(from, to < 0 ? undefined : to)
  }
  const no = (value: string, pattern: RegExp) => !pattern.test(value)
  const retry = (value: string, count: number) =>
    new RegExp(`(?:最多|上限|不超过)?重试(?:上限|次数)?(?:为|设为|是|:)?${count}次`).test(value) ||
    new RegExp(`重试(?:上限|次数)?(?:为|设为|是|:)?${count}次`).test(value)

  switch (id) {
    case "one-conclusion":
      return {
        final_retry_limit: /测试任务/.test(text) && /重试上限(?:设为|为|是|:)?5次/.test(text),
        obsolete_guess_removed: no(text, /(?:3|三)次|看错|重说一遍/),
      }
    case "deduplicate":
      return {
        test_only: /(?:仅限|只限|只能在)测试环境/.test(text),
        request_timeout: /请求超时(?:为|是|:)?30秒/.test(text),
        production_write_forbidden:
          /(?:不得|禁止|不可|不能|不允许)写入生产数据库|生产数据库(?:只读|禁止写入|不得写入)/.test(text) &&
          no(text, /(?:可以|允许|已)写入生产数据库|生产数据库(?:可以|允许)写入/),
      }
    case "different-scopes": {
      const alpha = segment(text, "alpha", "beta")
      const beta = segment(text, "beta", "gamma")
      const gamma = segment(text, "gamma", "delta")
      const delta = segment(text, "delta", "epsilon")
      const epsilon = segment(text, "epsilon", "zeta")
      const zeta = segment(text, "zeta")
      return {
        alpha_test_retry: /测试环境/.test(alpha) && retry(alpha, 2) && no(alpha, /生产环境|重试0次/),
        beta_production_no_retry:
          /生产环境/.test(beta) &&
          /(?:禁止|不得|不能|不允许)重试/.test(beta) &&
          /(?:次数(?:为|是|:)?|重试)0(?:次)?/.test(beta),
        gamma_output_path: /输出/.test(gamma) && /(?:必须|应|保存到)/.test(gamma) && /\/tmp\/gamma\.json/.test(gamma),
        delta_preserve_original: /(?:不能|不得|禁止|不可)删除原始记录/.test(delta),
        epsilon_read_only: /仅允许读取缓存|只能读取缓存|缓存只读/.test(epsilon) && no(epsilon, /允许写|可以写/),
        zeta_timeout: /超时(?:为|是|:)?45秒/.test(zeta),
      }
    }
    case "meaningful-rejection":
      return {
        a_rejected_for_offline_protocol:
          /(?:方案)?A.{0,18}(?:不支持|无法支持).{0,18}离线协议.{0,12}(?:否决|不采用|不可用)/.test(text) ||
          /(?:否决|不采用)(?:方案)?A.{0,18}(?:不支持|无法支持).{0,18}离线协议/.test(text),
        a_remains_disallowed: /(?:限制仍|约束仍|仍然).{0,16}(?:不要|不得|禁止|不能).{0,8}(?:重新)?选A/.test(text),
        b_selected: /(?:最终)?选择(?:方案)?B/.test(text),
        b_not_executed: /(?:方案)?B(?:尚未|未|没有)执行/.test(text) && no(text, /(?:方案)?B(?:已|已经)(?:执行|完成)/),
      }
    case "unresolved":
      return {
        both_causes_possible: /可能.{0,8}网络超时.{0,12}可能.{0,8}锁竞争/.test(text),
        cause_unresolved:
          /(?:未|尚未)确定(?:原因|根因)|原因(?:未|尚未)确定/.test(text) &&
          no(text, /(?:确定|确认)(?:为|是)(?:网络超时|锁竞争)|已排除(?:网络超时|锁竞争)/),
        read_only_logs: /只读(?:检查|核对)(?:超时)?日志/.test(text),
        config_unchanged: /(?:暂不|不得|不|禁止)(?:修改|变更)配置/.test(text),
      }
    case "evidenced-exclusion":
      return {
        pool_exhaustion_excluded:
          /已排除连接池耗尽|连接池耗尽.{0,4}(?:已|已经|被)排除/.test(text) &&
          no(text, /(?:未|尚未|不能|无法)排除连接池|连接池耗尽.{0,4}(?:未|尚未|不能|无法)(?:被)?排除/),
        exclusion_evidence:
          /\/var\/log\/app\.log/.test(text) &&
          /(?:低于|小于|<)5ms/.test(text) &&
          /最高(?:为|是|:)?12/.test(text) &&
          /上限(?:为|是|:)?20/.test(text),
        // A short "misread as 50, discarded" note is tolerated; 50 must never read as the current limit.
        obsolete_value_not_current: no(text, /上限(?:为|是|:)?50|50(?:为|是)(?:当前)?上限/),
        cause_open:
          /根因:?(?:仍|尚)?未(?:确定|确认)|(?:仍|尚)未(?:确定|确认)根因/.test(text) &&
          no(text, /根因(?:是|为|已确定|已确认)/),
        next_read_only: /只读检查锁等待/.test(text),
      }
    case "negative-check":
      return {
        checked_files_no_call:
          /packages\/core\/src\/retry\.ts/.test(text) &&
          /packages\/core\/src\/backoff\.ts/.test(text) &&
          /(?:没有|未|无|均未|都未|不含).{0,12}sleepWithJitter|sleepWithJitter.{0,12}(?:没有|未|无)/.test(text),
        reference_resolved:
          /旧调度器.{0,12}LegacyScheduler|LegacyScheduler.{0,12}旧调度器/.test(text) &&
          /packages\/core\/src\/legacy\/scheduler\.ts/.test(text),
        next_read_only: /只读检查.{0,4}packages\/opencode\/src\/session\/prompt\.ts/.test(text),
      }
    case "all-noise":
      return { empty: texts.length === 1 && texts[0] === NO_USEFUL_REASONING_TEXT.zh }
    case "short-reasoning": {
      const monday = segment(text, "周一", "周二")
      const tuesday = segment(text, "周二", "周三")
      const wednesday = segment(text, "周三", "周四")
      const thursday = segment(text, "周四", "周五")
      const friday = segment(text, "周五", "最终")
      return {
        monday_start: /周一.{0,8}83/.test(monday),
        tuesday_in_47_to_130: /入(?:库)?47.{0,12}(?:库存)?130/.test(tuesday),
        wednesday_out_29_to_101: /出(?:库)?29.{0,12}(?:库存)?101/.test(wednesday),
        thursday_floor_9_to_110: /(?:floor|向下取整|取整|⌊).{0,4}29\/3.{0,4}9.{0,12}(?:库存)?110/.test(thursday),
        friday_floor_27_to_83: /出(?:库)?.{0,10}(?:floor|向下取整|取整|⌊).{0,4}110\/4.{0,4}27.{0,12}(?:库存)?83/.test(
          friday,
        ),
        final_83: /最终库存(?:为|是|:)?83/.test(text),
      }
    }
    case "long-continuity": {
      const phase = segment(text, "阶段A", "迁移")
      const migration = segment(text, "迁移M", "下一步")
      const next = segment(text, "下一步", "请求超时")
      const limits = segment(text, "请求超时", "检查点")
      const lock = segment(text, "锁竞争")
      return {
        test_only_production_read_only: /仅限测试环境/.test(text) && /生产数据库(?:只能|仅能)?只读/.test(text),
        phase_a_done_no_repeat: /备份.{0,10}schema校验已(?:经)?完成/.test(phase) && /不要重复|不得重复/.test(phase),
        migration_failed_rollback_no_retry:
          /(?:实际)?执行失败/.test(migration) &&
          /不支持online/.test(migration) &&
          /已回滚/.test(migration) &&
          /不得重试M|禁止重试M/.test(migration) &&
          no(migration, /迁移M(?:已|已经)(?:成功|完成)|回滚(?:尚未|未)完成|回滚失败|(?:可以|允许)重试M/),
        next_read_only_unapproved:
          /只读核对日志和备份哈希/.test(next) &&
          /尚未授权再次迁移|未授权再次迁移/.test(next) &&
          no(next, /(?:已|已经)授权再次迁移|(?:可以|允许)再次迁移/),
        timeout_and_retry: /超时(?:为|是|:)?45秒/.test(limits) && /测试任务.{0,8}重试2次/.test(limits),
        checkpoint: /检查点.{0,10}\/tmp\/recovery-checkpoint\.json/.test(text),
        lock_unresolved:
          /(?:是否)?根因(?:仍|尚)?未确认|根因未定/.test(lock) &&
          no(lock, /(?:已|已经)确认锁竞争(?:是|为)根因|锁竞争(?:是|为)根因|锁竞争根因(?:已|已经)确认/),
      }
    }
    case "multiple-slots": {
      const [alpha = "", beta = "", gamma = ""] = texts.map(clean)
      return {
        three_independent_slots:
          texts.length === 3 &&
          [alpha, beta, gamma].every((value, index) =>
            ["alpha", "beta", "gamma"].every((name, other) => (index === other) === value.includes(name)),
          ),
        alpha_test_retry_and_no_production:
          /alpha.{0,8}测试环境.{0,8}重试2次/.test(alpha) &&
          /生产环境(?:禁止|不得|不能)执行/.test(alpha) &&
          no(alpha, /生产环境(?:可以|允许|已|已经)执行/),
        beta_done_pending_read_only:
          /beta.{0,6}备份已完成/.test(beta) &&
          /恢复校验尚未完成|恢复校验未完成/.test(beta) &&
          /下一步只读核对\/tmp\/beta\.json/.test(beta) &&
          no(beta, /恢复校验已完成/),
        gamma_failed_rollback_no_reuse:
          /gamma.{0,16}离线协议不兼容.{0,10}执行失败/.test(gamma) &&
          /已回滚/.test(gamma) &&
          /不得再次采用同一方案|不能再次采用同一方案/.test(gamma) &&
          no(gamma, /(?:未回滚|回滚失败|执行成功|可以再次采用同一方案|允许再次采用同一方案)/),
      }
    }
    default:
      throw new Error(`Unknown acceptance fixture: ${id}`)
  }
}
