#[test_only]
module bosphor::walrus_executor_tests {
    use sui::test_scenario;
    use bosphor::walrus_executor::{Self, ExecutorConfig};

    const RELAYER: address = @0xA;
    const USER: address = @0xB;
    const ATTACKER: address = @0xC;

    #[test]
    fun test_init_creates_shared_config() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let config = scenario.take_shared<ExecutorConfig>();
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test]
    fun test_update_relayer_success() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, USER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        // Verify new relayer can also update
        scenario.next_tx(USER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, RELAYER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test, expected_failure(abort_code = walrus_executor::ENotRelayer)]
    fun test_update_relayer_unauthorized_fails() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(ATTACKER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, ATTACKER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test]
    fun test_is_executed_returns_false_for_new_intent() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let config = scenario.take_shared<ExecutorConfig>();
            assert!(!walrus_executor::is_executed(&config, b"some_intent_id"));
            test_scenario::return_shared(config);
        };
        scenario.end();
    }
}
