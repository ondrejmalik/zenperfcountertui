// Declarative Jenkinsfile — 1:1 Drop-In Mirror of .github/workflows/ci.yml
def runCi(String stageArgs) {
    if (isUnix()) {
        sh "python3 scripts/ci.py ${stageArgs}"
    } else {
        bat """
            where py >nul 2>nul && (py -3 scripts/ci.py ${stageArgs}) || (python scripts/ci.py ${stageArgs})
        """
    }
}

pipeline {
    agent any

    options {
        timestamps()
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds(abortPrevious: true)
    }

    environment {
        ZEN2TOP_TELEMETRY_URL = 'off'
        ZEN2TOP_NO_AUDIO      = '1'
        ZEN2TOP_TEST_LOOPBACK = '1'
        PYTHONUTF8            = '1'
    }

    stages {
        stage('Parallel Verification Gates') {
            parallel {
                stage('verify (hygiene, layers, ratchet & bench)') {
                    steps {
                        script {
                            def baseRef = env.CHANGE_TARGET ? "origin/${env.CHANGE_TARGET}" : "HEAD~1"
                            runCi("hygiene")
                            runCi("layers --base ${baseRef}")
                            runCi("ratchet")
                            runCi("bench")
                        }
                    }
                }
                stage('verify (rust lint, test & headless)') {
                    steps {
                        script {
                            runCi("lint")
                            runCi("test")
                            runCi("headless")
                        }
                    }
                }
            }
        }
    }

    post {
        always {
            archiveArtifacts artifacts: 'benchmarks/**/*.json, .local/**/*.log', allowEmptyArchive: true
            cleanWs(cleanWhenNotBuilt: false, deleteDirs: true, disableDeferredWipeout: true, notFailBuild: true)
        }
    }
}
